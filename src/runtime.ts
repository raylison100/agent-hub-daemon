import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  AgentRunner,
  Ledger,
  McpBridge,
  Pricing,
  ToolRegistry,
  budgetFor,
  createAdapter,
  defaultPolicy,
  loadAgentsRepo,
  nativeTools,
  type AgentProfile,
  type AgentSummary,
  type AgentsRepo,
  type Policy,
  type RunEvent,
  type RunResult,
  type ToolCallPart,
  type ToolDefinition,
} from '@agent-hub/core'
import { ApprovalQueue, type ApprovalDecision, type PendingApproval } from './approvals.js'
import type { DaemonConfig } from './config.js'
import { openDb } from './db.js'
import { SessionStore } from './store.js'

export interface RunRequest {
  sessionId: string
  text: string
  runId?: string
  emit: (event: RunEvent) => void
  onApproval: (info: PendingApproval) => void
  signal?: AbortSignal
}

export class Runtime {
  readonly ledger: Ledger
  readonly store: SessionStore
  readonly registry = new ToolRegistry()
  readonly mcp = new McpBridge()
  readonly approvals = new ApprovalQueue()
  repo!: AgentsRepo
  pricing!: Pricing

  constructor(readonly config: DaemonConfig) {
    const db = openDb(config.dbPath)
    this.ledger = new Ledger(db)
    this.store = new SessionStore(db, this.ledger)
    this.registry.registerAll(nativeTools())
    this.reload()
  }

  /** Recarrega perfis, politicas, skills e precos do repositorio `agents`. */
  reload(): void {
    if (!existsSync(this.config.agentsDir)) throw new Error(`diretorio de agentes nao existe: ${this.config.agentsDir}`)
    this.repo = loadAgentsRepo(this.config.agentsDir)
    this.pricing = Pricing.fromFile(join(this.config.agentsDir, 'pricing.json'))
  }

  agents(): AgentSummary[] {
    return [...this.repo.profiles.values()].map((p) => ({
      name: p.name,
      description: p.description,
      provider: p.provider,
      model: p.model,
      reasoning: p.reasoning,
      tools: [...p.tools.native, ...p.tools.mcp.map((s) => `mcp:${s}`)],
      budget: p.budget,
    }))
  }

  profile(name: string): AgentProfile {
    const p = this.repo.profiles.get(name)
    if (!p) throw new Error(`agente desconhecido: ${name}`)
    return p
  }

  policyFor(profile: AgentProfile): Policy {
    return this.repo.policies.get(profile.policy) ?? defaultPolicy
  }

  /** Confere se o diretorio esta na lista de workspaces permitidos do config. */
  assertWorkspace(dir: string): string {
    const target = resolve(dir)
    const allowed = this.config.workspaces.some((w) => target === w || target.startsWith(w + sep))
    if (!allowed) throw new Error(`workspace nao permitido: ${target}. Adicione em workspaces no config.toml`)
    if (!existsSync(target)) throw new Error(`workspace nao existe: ${target}`)
    return target
  }

  async ensureMcp(profile: AgentProfile): Promise<void> {
    for (const name of profile.tools.mcp) {
      const config = this.repo.mcp.servers[name]
      if (!config) throw new Error(`servidor MCP nao configurado: ${name}`)
      const tools = await this.mcp.connect(name, config)
      this.registry.registerAll(tools)
    }
  }

  /** Executa um run completo em uma sessao, com escalada para o agente de fallback quando a chamada de ferramenta nao se recupera. */
  async run(req: RunRequest): Promise<RunResult> {
    const session = this.store.get(req.sessionId)
    if (!session) throw new Error(`sessao nao encontrada: ${req.sessionId}`)
    const profile = this.profile(session.agent)
    const runId = req.runId ?? randomUUID()
    const result = await this.runWith(profile, session.workspace, req, runId)
    if (result.stop !== 'tool_call_invalid' || !profile.fallback_agent) return result
    const fallback = this.profile(profile.fallback_agent)
    req.emit({ type: 'escalation', from: profile.name, to: fallback.name, reason: 'chamadas de ferramenta invalidas apos reparo' })
    return this.runWith(fallback, session.workspace, req, randomUUID(), runId)
  }

  private async runWith(profile: AgentProfile, workspace: string, req: RunRequest, runId: string, parentRunId?: string): Promise<RunResult> {
    await this.ensureMcp(profile)
    const adapter = createAdapter(profile)
    const agentDay = this.repo.budgets.agents[profile.name]?.day_usd
    const budget = budgetFor(this.ledger, profile, { runId, sessionId: req.sessionId }, agentDay, this.repo.budgets.global_month_usd)
    const history = this.store.history(req.sessionId)
    const runner = new AgentRunner({
      adapter,
      profile,
      tools: this.registry,
      skills: this.repo.skills,
      policy: this.policyFor(profile),
      pricing: this.pricing,
      ledger: this.ledger,
      budget,
      workspace,
      approve: (call, def) => this.ask(req, runId, call, def),
      emit: (event) => this.observe(req, runId, event),
      signal: req.signal,
    })
    const result = await runner.run({ runId, sessionId: req.sessionId, history, userText: req.text })
    this.store.appendMessages(req.sessionId, runId, result.appended)
    if (history.length === 0) this.store.touch(req.sessionId, req.text.slice(0, 80))
    void parentRunId
    return result
  }

  private async ask(req: RunRequest, runId: string, call: ToolCallPart, def: ToolDefinition): Promise<ApprovalDecision> {
    const { info, promise } = this.approvals.request(
      { sessionId: req.sessionId, runId, tool: def.name, args: call.args, risk: def.risk },
      this.config.approvalTimeoutMs,
    )
    this.store.recordApproval(info.id, req.sessionId, runId, def.name, call.args)
    req.onApproval(info)
    const decision = await promise
    this.store.resolveApproval(info.id, decision)
    return decision
  }

  private observe(req: RunRequest, runId: string, event: RunEvent): void {
    if (event.type === 'tool_call') {
      this.store.recordToolEvent({ sessionId: req.sessionId, runId, name: event.call.name, args: event.call.args, decision: event.decision })
    }
    if (event.type === 'tool_result') {
      this.store.recordToolEvent({
        sessionId: req.sessionId,
        runId,
        name: event.name,
        args: null,
        decision: 'executed',
        result: event.content.slice(0, 4000),
        isError: event.isError,
        ms: event.ms,
      })
    }
    req.emit(event)
  }
}
