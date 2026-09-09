import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  AgentRunner,
  HookRunner,
  Ledger,
  McpBridge,
  Pricing,
  PluginsFileSchema,
  Redactor,
  ToolRegistry,
  activatedSkills,
  budgetFor,
  classifierPrompt,
  createAdapter,
  defaultPolicy,
  gitPluginDir,
  loadAgentsRepo,
  messageText,
  nativeTools,
  parseClassifierAnswer,
  route,
  type AgentProfile,
  type AgentSummary,
  type AgentsRepo,
  type Budget,
  type BudgetScope,
  type DelegationResult,
  type Message,
  type Policy,
  type RouteResult,
  type RunEvent,
  type RunResult,
  type Summarizer,
  type ToolCallPart,
  type ToolDefinition,
} from '@agent-hub/core'
import type { Database as DatabaseType } from 'better-sqlite3'
import { ApprovalQueue, type ApprovalDecision, type PendingApproval } from './approvals.js'
import type { AutomationRunner } from './automation.js'
import type { DaemonConfig } from './config.js'
import { openDb } from './db.js'
import { SessionStore } from './store.js'
import { Webhooks } from './webhooks.js'

export interface RunRequest {
  sessionId: string
  text: string
  runId?: string
  emit: (event: RunEvent) => void
  onApproval: (info: PendingApproval) => void
  signal?: AbortSignal
  policyOverride?: Policy
  budgetOverride?: { runUsd?: number; sessionUsd?: number }
  autoApprove?: boolean
}

export const draftPolicy: Policy = { read: 'allow', write: 'deny', exec: 'deny' }

const summarySystem =
  'Voce resume conversas entre um usuario e um agente de programacao. Preserve decisoes tomadas, arquivos tocados, ' +
  'erros encontrados e o que ainda falta. Sem introducao, sem opiniao, em topicos curtos.'

export class Runtime {
  readonly db: DatabaseType
  readonly ledger: Ledger
  readonly store: SessionStore
  readonly registry = new ToolRegistry()
  readonly mcp = new McpBridge()
  readonly approvals = new ApprovalQueue()
  private readonly activeBudgets = new Map<string, Budget>()
  readonly hooks = new Webhooks([], process.env, (m) => console.error(m))
  automation!: AutomationRunner
  repo!: AgentsRepo
  pricing!: Pricing
  redactor!: Redactor
  hookRunner!: HookRunner

  constructor(readonly config: DaemonConfig) {
    const db = openDb(config.dbPath)
    this.db = db
    this.ledger = new Ledger(db)
    this.store = new SessionStore(db, this.ledger)
    this.registry.registerAll(nativeTools())
    this.reload()
  }

  /** Recarrega perfis, politicas, skills, roteamento, segredos, webhooks e precos do repositorio `agents`. */
  reload(): void {
    if (!existsSync(this.config.agentsDir)) throw new Error(`diretorio de agentes nao existe: ${this.config.agentsDir}`)
    this.repo = loadAgentsRepo(this.config.agentsDir)
    this.pricing = Pricing.fromFile(join(this.config.agentsDir, 'pricing.json'))
    this.redactor = new Redactor(this.repo.secrets)
    this.hooks.replace(this.repo.webhooks)
    this.hookRunner = new HookRunner(this.repo.hooks, (m) => console.error(`hook: ${m}`))
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

  /** Escolhe o agente: o explicito vence; depois as regras por palavra chave; por fim o classificador por modelo, se configurado. */
  async resolveAgent(explicit: string | undefined, text: string, workspace: string): Promise<{ agent: string; routed: RouteResult | null }> {
    if (explicit) return { agent: this.profile(explicit).name, routed: null }
    const ctx = { text, workspace }
    let routed = route(this.repo.routing, ctx)
    if (!routed && this.repo.routing.classifier) {
      const intent = await this.classify(text)
      if (intent) routed = route(this.repo.routing, ctx, intent)
    }
    if (!routed) throw new Error('nenhuma regra de roteamento casou; informe o agente')
    return { agent: this.profile(routed.agent).name, routed }
  }

  /** Classificador de intencao por modelo barato, com custo lancado no ledger sob a sessao `roteamento`. */
  private async classify(text: string): Promise<string | null> {
    const classifier = this.repo.routing.classifier!
    const profile = this.repo.profiles.get(classifier.agent)
    if (!profile) return null
    const adapter = createAdapter(profile)
    const result = await adapter.chat({
      system: 'Voce classifica pedidos. Responda apenas com o nome da intencao.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: classifierPrompt(this.repo.routing.intents, text, classifier.max_prompt_chars) }] }],
      tools: [],
      maxOutput: 20,
      reasoning: 'low',
      systemCacheTtl: '5m',
      providerOptions: profile.provider_options,
    })
    this.ledger.record({
      ts: Date.now(),
      sessionId: 'roteamento',
      runId: randomUUID(),
      step: 0,
      agent: profile.name,
      provider: adapter.provider,
      model: result.model,
      usage: result.usage,
      costUsd: this.pricing.cost(adapter.provider, result.model, result.usage),
      pricingVersion: this.pricing.version,
      latencyMs: result.latencyMs,
      stopReason: 'classify',
    })
    return parseClassifierAnswer(messageText(result.message), this.repo.routing.intents)
  }

  /** Clona plugins declarados por git em agents/.plugins e atualiza os ja clonados. */
  syncGitPlugins(log: (m: string) => void): void {
    const file = join(this.config.agentsDir, 'plugins.json')
    if (!existsSync(file)) return
    const entries = PluginsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).plugins.filter((e) => e.enabled && e.git)
    for (const entry of entries) {
      const dir = gitPluginDir(this.config.agentsDir, entry.git!)
      try {
        if (existsSync(dir)) {
          execFileSync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], { stdio: 'pipe' })
          log(`plugin atualizado: ${dir}`)
        } else {
          mkdirSync(dirname(dir), { recursive: true })
          const args = ['clone', '--depth', '1', '--quiet', ...(entry.ref ? ['--branch', entry.ref] : []), entry.git!, dir]
          execFileSync('git', args, { stdio: 'pipe' })
          log(`plugin clonado: ${dir}`)
        }
      } catch (err) {
        log(`plugin ${entry.git}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.reload()
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

  overrideBudget(runId: string, scope: BudgetScope, limitUsd: number): boolean {
    const budget = this.activeBudgets.get(runId)
    if (!budget) return false
    budget.override(scope, limitUsd)
    return true
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
    if (req.budgetOverride?.runUsd !== undefined) budget.override('run', req.budgetOverride.runUsd)
    if (req.budgetOverride?.sessionUsd !== undefined) budget.override('session', req.budgetOverride.sessionUsd)
    this.activeBudgets.set(runId, budget)
    const history = this.store.history(req.sessionId)
    const runner = new AgentRunner({
      adapter,
      profile,
      tools: this.registry,
      skills: this.repo.skills,
      policy: req.policyOverride ?? this.policyFor(profile),
      pricing: this.pricing,
      ledger: this.ledger,
      budget,
      workspace,
      approve: (call, def) => this.ask(req, runId, call, def),
      emit: (event) => this.observe(req, runId, event),
      summarize: this.summarizerFor(profile, req.sessionId, runId),
      redact: (text) => this.redactor.redact(text),
      preloadSkills: activatedSkills(this.repo.skills, profile.skills, { text: req.text, workspace }, this.repo.routing.intents),
      delegate: (agent, task) => this.delegate(req, workspace, runId, agent, task),
      hooks: this.hookRunner,
      signal: req.signal,
    })
    try {
      const result = await runner.run({ runId, sessionId: req.sessionId, history, userText: req.text, parentRunId })
      this.store.appendMessages(req.sessionId, runId, result.appended)
      if (history.length === 0) this.store.touch(req.sessionId, req.text.slice(0, 80))
      return result
    } finally {
      this.activeBudgets.delete(runId)
    }
  }

  /** Run filho com outro perfil, sem historico da sessao, custo lancado na mesma sessao sob o run pai. */
  private async delegate(req: RunRequest, workspace: string, parentRunId: string, agent: string, task: string): Promise<DelegationResult> {
    const child = this.profile(agent)
    await this.ensureMcp(child)
    const adapter = createAdapter(child)
    const runId = randomUUID()
    const agentDay = this.repo.budgets.agents[child.name]?.day_usd
    const budget = budgetFor(this.ledger, child, { runId, sessionId: req.sessionId }, agentDay, this.repo.budgets.global_month_usd)
    this.activeBudgets.set(runId, budget)
    const text: string[] = []
    const runner = new AgentRunner({
      adapter,
      profile: child,
      tools: this.registry,
      skills: this.repo.skills,
      policy: req.policyOverride ?? this.policyFor(child),
      pricing: this.pricing,
      ledger: this.ledger,
      budget,
      workspace,
      approve: (call, def) => this.ask(req, runId, call, def),
      emit: (event) => {
        if (event.type === 'text_delta') text.push(event.delta)
        else if (event.type !== 'run_finished') this.observe(req, runId, event)
      },
      redact: (t) => this.redactor.redact(t),
      hooks: this.hookRunner,
      signal: req.signal,
    })
    try {
      const result = await runner.run({ runId, sessionId: req.sessionId, history: [], userText: task, parentRunId })
      const last = [...result.appended].reverse().find((m) => m.role === 'assistant')
      return { text: (last ? messageText(last) : text.join('')) || text.join(''), costUsd: result.costUsd, runId, stop: result.stop }
    } finally {
      this.activeBudgets.delete(runId)
    }
  }

  /** Sumarizador para compactacao: usa o perfil em `context.summarizer`, com custo lancado no ledger sob o run pai. */
  private summarizerFor(profile: AgentProfile, sessionId: string, parentRunId: string): Summarizer | undefined {
    const name = profile.context.summarizer
    if (!name) return undefined
    const summarizer = this.repo.profiles.get(name)
    if (!summarizer) return undefined
    return async (messages: Message[]) => {
      const adapter = createAdapter(summarizer)
      const transcript = messages.map(renderForSummary).join('\n')
      const result = await adapter.chat({
        system: summarySystem,
        messages: [{ role: 'user', parts: [{ type: 'text', text: `Conversa:\n\n${transcript}\n\nResuma.` }] }],
        tools: [],
        maxOutput: Math.min(summarizer.max_output, 4000),
        reasoning: 'low',
        systemCacheTtl: '5m',
        providerOptions: summarizer.provider_options,
      })
      this.ledger.record({
        ts: Date.now(),
        sessionId,
        runId: randomUUID(),
        parentRunId,
        step: 0,
        agent: summarizer.name,
        provider: adapter.provider,
        model: result.model,
        usage: result.usage,
        costUsd: this.pricing.cost(adapter.provider, result.model, result.usage),
        pricingVersion: this.pricing.version,
        latencyMs: result.latencyMs,
        stopReason: 'summary',
      })
      return messageText(result.message)
    }
  }

  private async ask(req: RunRequest, runId: string, call: ToolCallPart, def: ToolDefinition): Promise<ApprovalDecision> {
    if (req.autoApprove) {
      this.store.recordToolEvent({ sessionId: req.sessionId, runId, name: def.name, args: call.args, decision: 'auto_approved' })
      return 'allow'
    }
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

function renderForSummary(m: Message): string {
  const parts = m.parts.map((p) => {
    if (p.type === 'text') return p.text
    if (p.type === 'tool_call') return `[chamou ${p.name} ${JSON.stringify(p.args ?? {}).slice(0, 200)}]`
    return `[resultado${p.isError ? ' com erro' : ''}: ${p.content.slice(0, 300)}]`
  })
  return `${m.role}: ${parts.join(' ')}`
}
