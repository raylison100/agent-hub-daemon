import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
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
  apiKeyEnv,
  approxTokens,
  budgetFor,
  classifierPrompt,
  createAdapter,
  defaultPolicy,
  gitPluginDir,
  improverPrompt,
  isDestructive,
  loadAgentsRepo,
  messageText,
  nativeTools,
  classifyIntent,
  feedbackDelta,
  parseClassifierAnswer,
  route,
  scoreAgents,
  type AgentProfile,
  type AgentSummary,
  type AgentsRepo,
  type Budget,
  type BudgetScope,
  type DelegationOptions,
  type DelegationResult,
  type Message,
  type Policy,
  type RoutedBy,
  type RouteResult,
  type RunEvent,
  type ScoreCandidate,
  type ScoredAgent,
  type StatsOverview,
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
import { OtelExporter, traceIdFrom } from './otel.js'
import { PushService } from './push.js'
import { SecretStore } from './secrets.js'
import { SessionStore } from './store.js'
import { Webhooks } from './webhooks.js'
import { createWorktree, isGitRepo } from './worktrees.js'

interface SpawnedTask {
  taskId: string
  runId: string
  agent: string
  promise: Promise<DelegationResult>
  result?: DelegationResult
  collected: boolean
}

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
  onApprovalPush?: boolean
  reasoningOverride?: 'low' | 'medium' | 'high' | 'max'
  agentOverride?: string
  improve?: boolean
}

export const autoAgent = 'auto'

export const draftPolicy: Policy = { read: 'allow', write: 'deny', exec: 'deny' }

const summarySystem =
  'Voce resume conversas entre um usuario e um agente de programacao. Preserve decisoes tomadas, arquivos tocados, ' +
  'erros encontrados e o que ainda falta. Sem introducao, sem opiniao, em topicos curtos.'

const dayMs = 86_400_000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Sequencias de dias ativos consecutivos a partir das datas locais ordenadas. */
function streaksOf(dates: string[]): { current: number; longest: number } {
  let longest = 0
  let run = 0
  let prev: number | null = null
  for (const d of dates) {
    const ts = new Date(`${d}T00:00:00`).getTime()
    run = prev !== null && ts - prev === dayMs ? run + 1 : 1
    if (run > longest) longest = run
    prev = ts
  }
  const today = startOfDay(Date.now())
  const last = dates.length > 0 ? new Date(`${dates[dates.length - 1]}T00:00:00`).getTime() : null
  const current = last !== null && today - last <= dayMs ? run : 0
  return { current, longest }
}

export interface ResolvedAgent {
  agent: string
  routed: RouteResult | null
  by: RoutedBy
  intent?: string | null
  ranking?: ScoredAgent[]
}

/** Texto curto do motivo da escolha do agente para o evento `routed`. */
function routedReason(chosen: ResolvedAgent): string {
  if (chosen.routed) return `regra ${JSON.stringify(chosen.routed.rule.when)}`
  if (chosen.by === 'score') {
    const top = chosen.ranking?.find((r) => r.agent === chosen.agent)
    return top ? `pontuacao ${top.score} (capacidade ${top.capability}, custo ${top.costPerMillion.toFixed(2)} USD/M)` : 'pontuacao'
  }
  if (chosen.by === 'default') return 'default_agent do routing.json'
  return chosen.by
}

export class Runtime {
  readonly db: DatabaseType
  readonly ledger: Ledger
  readonly store: SessionStore
  readonly registry = new ToolRegistry()
  readonly mcp = new McpBridge()
  readonly approvals = new ApprovalQueue()
  private readonly activeBudgets = new Map<string, Budget>()
  private readonly spawned = new Map<string, Map<string, SpawnedTask>>()
  readonly hooks = new Webhooks([], process.env, (m) => console.error(m))
  readonly otel: OtelExporter | null
  readonly push: PushService
  readonly secrets: SecretStore
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
    this.otel = config.otelEndpoint
      ? new OtelExporter({ endpoint: config.otelEndpoint, headers: config.otelHeaders, serviceName: 'agent-hub-daemon', log: (m) => console.error(m) })
      : null
    this.push = new PushService(config.home, db, (m) => console.error(m))
    this.secrets = new SecretStore(config.home, db)
    this.secrets.applyToEnv()
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
      budget: { ...p.budget, day_usd: this.repo.budgets.agents[p.name]?.day_usd },
      context_window: p.context.window,
      delegates: p.delegates,
    }))
  }

  /** Gasto de hoje e do mes, por agente e global, para o painel de limites da interface. */
  costStatus(): { todayUsd: number; monthUsd: number; globalMonthLimit: number | null; agents: Record<string, { todayUsd: number; dayLimit: number | null }> } {
    const day = new Date()
    day.setHours(0, 0, 0, 0)
    const month = new Date(day)
    month.setDate(1)
    const agents: Record<string, { todayUsd: number; dayLimit: number | null }> = {}
    for (const row of this.ledger.report('agent', { since: day.getTime() })) {
      agents[row.key] = { todayUsd: row.costUsd, dayLimit: this.repo.budgets.agents[row.key]?.day_usd ?? null }
    }
    for (const name of this.repo.profiles.keys()) {
      if (!agents[name]) agents[name] = { todayUsd: 0, dayLimit: this.repo.budgets.agents[name]?.day_usd ?? null }
    }
    return {
      todayUsd: this.ledger.totals({ since: day.getTime() }).costUsd,
      monthUsd: this.ledger.totals({ since: month.getTime() }).costUsd,
      globalMonthLimit: this.repo.budgets.global_month_usd ?? null,
      agents,
    }
  }

  /** Estatisticas de uso para a tela inicial: totais, sequencia de dias, hora de pico, modelo favorito e atividade diaria. */
  statsOverview(days?: number): StatsOverview {
    const since = days ? startOfDay(Date.now() - (days - 1) * dayMs) : 0
    const one = <T>(sql: string): T => this.db.prepare(sql).get(since) as T
    const sessions = one<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?').n
    const messages = one<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?').n
    const ledger = one<{ tokens: number | null; cost: number | null }>(
      'SELECT SUM(input + output + cache_read + cache_write + reasoning) AS tokens, SUM(cost_usd) AS cost FROM ledger WHERE ts >= ?',
    )
    const byDay = this.db
      .prepare("SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY d ORDER BY d")
      .all(since) as { d: string; n: number }[]
    const peak = this.db
      .prepare("SELECT CAST(strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY h ORDER BY n DESC, h LIMIT 1")
      .get(since) as { h: number } | undefined
    const models = this.db
      .prepare('SELECT model, COUNT(*) AS calls, SUM(input + output + cache_read + cache_write + reasoning) AS tokens, SUM(cost_usd) AS cost_usd FROM ledger WHERE ts >= ? GROUP BY model ORDER BY calls DESC')
      .all(since) as { model: string; calls: number; tokens: number; cost_usd: number }[]
    const streaks = streaksOf(byDay.map((r) => r.d))
    return {
      user: userInfo().username,
      sessions,
      messages,
      total_tokens: ledger.tokens ?? 0,
      active_days: byDay.length,
      current_streak_days: streaks.current,
      longest_streak_days: streaks.longest,
      peak_hour: peak?.h ?? null,
      favorite_model: models[0]?.model ?? null,
      cost_usd: ledger.cost ?? 0,
      days: byDay.map((r) => ({ date: r.d, count: r.n })),
      models,
    }
  }

  profile(name: string): AgentProfile {
    const p = this.repo.profiles.get(name)
    if (!p) throw new Error(`agente desconhecido: ${name}`)
    return p
  }

  /** Politica do perfil. Execucao `allow` sem sandbox por container cai para `ask`, como manda o documento 06. */
  policyFor(profile: AgentProfile): Policy {
    const policy = this.repo.policies.get(profile.policy) ?? defaultPolicy
    if (policy.exec === 'allow' && !profile.sandbox) return { ...policy, exec: 'ask' }
    return policy
  }

  /** Escolhe o agente: explicito vence; depois regras por palavra chave; classificador por modelo; pontuacao custo x capacidade; por fim o `default_agent`. `auto` significa decidir a cada mensagem. */
  async resolveAgent(explicit: string | undefined, text: string, workspace: string): Promise<ResolvedAgent> {
    if (explicit && explicit !== autoAgent) return { agent: this.profile(explicit).name, routed: null, by: 'fixed' }
    const ctx = { text, workspace }
    let routed = route(this.repo.routing, ctx)
    if (routed) return { agent: this.profile(routed.agent).name, routed, by: 'rule' }
    let intent = classifyIntent(text, this.repo.routing.intents)
    if (intent === null && this.repo.routing.classifier && text.trim()) {
      intent = await this.classify(text)
      if (intent) routed = route(this.repo.routing, ctx, intent)
      if (routed) return { agent: this.profile(routed.agent).name, routed, by: 'classifier' }
    }
    const scored = this.scoreFor(intent, text)
    if (scored.chosen) return { agent: this.profile(scored.chosen.agent).name, routed: null, by: 'score', intent, ranking: scored.ranking }
    if (this.repo.routing.default_agent) return { agent: this.profile(this.repo.routing.default_agent).name, routed: null, by: 'default', intent, ranking: scored.ranking }
    throw new Error('nenhuma regra casou, nenhum agente pontuou e nao ha default_agent em routing.json')
  }

  /** Ranking deterministico de custo x capacidade entre os perfis com capacidade declarada para a intencao. */
  scoreFor(intent: string | null, text: string): { chosen: ScoredAgent | null; ranking: ScoredAgent[] } {
    const scoring = this.repo.routing.scoring
    if (!scoring) return { chosen: null, ranking: [] }
    const candidates: ScoreCandidate[] = [...this.repo.profiles.values()].map((p) => ({
      name: p.name,
      provider: p.provider,
      model: p.model,
      capabilities: p.routing.capabilities,
      maxPromptTokens: p.routing.max_prompt_tokens,
      contextWindow: p.context.window,
      maxOutput: p.max_output,
    }))
    return scoreAgents(candidates, (provider, model) => this.priceOrNull(provider, model), scoring, {
      intent,
      promptTokens: approxTokens(text),
      unavailable: (name) => this.unavailableReason(name),
      adjustments: this.feedbackAdjustments(intent),
    })
  }

  /** Ajuste aprendido por agente para a intencao, somando o feedback da intencao com o feedback geral. */
  feedbackAdjustments(intent: string | null): Record<string, number> {
    const cfg = this.repo.routing.scoring?.feedback
    if (!cfg) return {}
    const key = intent ?? '*'
    const rows = this.db
      .prepare("SELECT agent, COALESCE(intent, '*') AS intent, SUM(verdict = 'good') AS good, SUM(verdict = 'bad') AS bad FROM feedback WHERE COALESCE(intent, '*') = ? GROUP BY agent")
      .all(key) as { agent: string; good: number; bad: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.agent] = feedbackDelta(r.good, r.bad, cfg)
    return out
  }

  /** Registra ou limpa o veredito do usuario sobre a resposta de um run, com agente e intencao gravados na hora do roteamento. */
  setFeedback(sessionId: string, runId: string, verdict: 'good' | 'bad' | 'none'): void {
    if (verdict === 'none') {
      this.db.prepare('DELETE FROM feedback WHERE run_id = ?').run(runId)
      return
    }
    const run = this.db.prepare('SELECT agent, intent FROM runs WHERE run_id = ?').get(runId) as { agent: string; intent: string | null } | undefined
    const agent = run?.agent ?? (this.db.prepare('SELECT agent FROM messages WHERE run_id = ? AND agent IS NOT NULL LIMIT 1').get(runId) as { agent: string } | undefined)?.agent
    if (!agent) throw new Error(`run sem agente conhecido: ${runId}`)
    this.db
      .prepare('INSERT INTO feedback (run_id, session_id, agent, intent, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at')
      .run(runId, sessionId, agent, run?.intent ?? null, verdict, Date.now())
  }

  feedbackList(sessionId: string): { run_id: string; verdict: 'good' | 'bad' }[] {
    return this.db.prepare('SELECT run_id, verdict FROM feedback WHERE session_id = ?').all(sessionId) as { run_id: string; verdict: 'good' | 'bad' }[]
  }

  /** Somatorio de feedback por agente e intencao com o delta de capacidade resultante. */
  feedbackSummary(): { agent: string; intent: string; good: number; bad: number; delta: number }[] {
    const cfg = this.repo.routing.scoring?.feedback
    const rows = this.db
      .prepare("SELECT agent, COALESCE(intent, '*') AS intent, SUM(verdict = 'good') AS good, SUM(verdict = 'bad') AS bad FROM feedback GROUP BY agent, COALESCE(intent, '*') ORDER BY agent, intent")
      .all() as { agent: string; intent: string; good: number; bad: number }[]
    return rows.map((r) => ({ ...r, delta: cfg ? feedbackDelta(r.good, r.bad, cfg) : 0 }))
  }

  private priceOrNull(provider: string, model: string): ReturnType<Pricing['resolve']> | null {
    try {
      return this.pricing.resolve(provider, model)
    } catch {
      return null
    }
  }

  /** Motivo pelo qual um agente nao pode receber runs agora: chave ausente ou limite diario estourado. */
  private unavailableReason(name: string): string | null {
    const profile = this.repo.profiles.get(name)
    if (!profile) return 'perfil nao carregado'
    const keyEnv = apiKeyEnv(profile)
    if (keyEnv && !process.env[keyEnv]) return `sem chave ${keyEnv}`
    const dayLimit = this.repo.budgets.agents[name]?.day_usd
    if (dayLimit !== undefined && dayLimit > 0) {
      const day = new Date()
      day.setHours(0, 0, 0, 0)
      const spent = this.ledger.report('agent', { since: day.getTime() }).find((r) => r.key === name)?.costUsd ?? 0
      if (spent >= dayLimit) return `limite diario de ${dayLimit} USD atingido`
    }
    return null
  }

  /** Reescreve o pedido do usuario para o agente alvo com o modelo barato de `prompt_improver`, lancando o custo na sessao. */
  private async improvePrompt(sessionId: string, runId: string, text: string, target: AgentProfile): Promise<{ improved: string; by: string; costUsd: number } | null> {
    const cfg = this.repo.routing.prompt_improver
    if (!cfg || text.trim().length < cfg.min_chars || text.trimStart().startsWith('/')) return null
    const improver = this.repo.profiles.get(cfg.agent)
    if (!improver || improver.name === target.name) return null
    const adapter = createAdapter(improver)
    const result = await adapter.chat({
      system: 'Voce reescreve pedidos para agentes de programacao. Responda apenas com o prompt reescrito.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: improverPrompt(text, target.name, target.description) }] }],
      tools: [],
      maxOutput: cfg.max_output,
      reasoning: 'low',
      systemCacheTtl: '5m',
      providerOptions: improver.provider_options,
    })
    const costUsd = this.pricing.cost(adapter.provider, result.model, result.usage)
    this.ledger.record({
      ts: Date.now(),
      sessionId,
      runId: randomUUID(),
      parentRunId: runId,
      step: 0,
      agent: improver.name,
      provider: adapter.provider,
      model: result.model,
      usage: result.usage,
      costUsd,
      pricingVersion: this.pricing.version,
      latencyMs: result.latencyMs,
      stopReason: 'improve',
    })
    const improved = messageText(result.message).trim()
    if (!improved || improved.length < 8) return null
    return { improved, by: improver.name, costUsd }
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
    const runId = req.runId ?? randomUUID()
    const chosen = req.agentOverride
      ? { agent: this.profile(req.agentOverride).name, routed: null, by: 'override' as const }
      : await this.resolveAgent(session.agent, req.text, session.workspace)
    const base = this.profile(chosen.agent)
    this.db
      .prepare('INSERT OR REPLACE INTO runs (run_id, session_id, agent, intent, routed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, req.sessionId, base.name, chosen.routed?.intent ?? chosen.intent ?? null, chosen.by, Date.now())
    if (session.agent === autoAgent || chosen.by === 'override') {
      req.emit({
        type: 'routed',
        agent: base.name,
        model: `${base.provider}/${base.model}`,
        by: chosen.by,
        intent: chosen.routed?.intent ?? chosen.intent ?? null,
        reason: routedReason(chosen),
        ranking: chosen.ranking,
      })
    }
    if (req.improve) {
      const improved = await this.improvePrompt(req.sessionId, runId, req.text, base).catch(() => null)
      if (improved) {
        req.emit({ type: 'prompt_improved', by: improved.by, original: req.text, improved: improved.improved, costUsd: improved.costUsd })
        req = { ...req, text: `${improved.improved}\n\n<pedido_original>\n${req.text}\n</pedido_original>` }
      }
    }
    const profile = req.reasoningOverride ? { ...base, reasoning: req.reasoningOverride } : base
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
      emit: (event) => this.observe(req, runId, event, profile, adapter.provider),
      summarize: this.summarizerFor(profile, req.sessionId, runId),
      redact: (text) => this.redactor.redact(text),
      preloadSkills: activatedSkills(this.repo.skills, profile.skills, { text: req.text, workspace }, this.repo.routing.intents),
      delegate: (agent, task, opts) => this.delegate(req, workspace, runId, agent, task, undefined, opts),
      spawn: (agent, task, opts) => this.spawn(req, workspace, runId, agent, task, opts),
      collect: (taskId, wait) => this.collect(runId, taskId, wait),
      pendingSpawns: () => [...(this.spawned.get(runId)?.values() ?? [])].filter((t) => !t.collected).length,
      hooks: this.hookRunner,
      sandbox: profile.sandbox,
      signal: req.signal,
    })
    try {
      const result = await runner.run({ runId, sessionId: req.sessionId, history, userText: req.text, parentRunId })
      this.store.appendMessages(req.sessionId, runId, result.appended)
      if (history.length === 0) this.store.touch(req.sessionId, req.text.slice(0, 80))
      return result
    } finally {
      this.activeBudgets.delete(runId)
      this.spawned.delete(runId)
    }
  }

  /** Inicia um subagente sem esperar. O resultado fica guardado ate o pai chamar collect. */
  private async spawn(req: RunRequest, workspace: string, parentRunId: string, agent: string, task: string, opts: DelegationOptions): Promise<{ taskId: string; runId: string }> {
    const runId = randomUUID()
    const taskId = runId.slice(0, 8)
    const entry: SpawnedTask = { taskId, runId, agent, promise: Promise.resolve({ text: '', costUsd: 0, runId, stop: 'error' }), collected: false }
    let tasks = this.spawned.get(parentRunId)
    if (!tasks) {
      tasks = new Map()
      this.spawned.set(parentRunId, tasks)
    }
    tasks.set(taskId, entry)
    entry.promise = this.delegate(req, workspace, parentRunId, agent, task, undefined, { ...opts, taskId, runId, background: true }).then(
      (r) => {
        entry.result = { ...r, taskId, agent }
        return entry.result
      },
      (err: unknown) => {
        entry.result = { text: err instanceof Error ? err.message : String(err), costUsd: 0, runId, stop: 'error', taskId, agent }
        return entry.result
      },
    )
    return { taskId, runId }
  }

  private async collect(parentRunId: string, taskId: string | undefined, wait: boolean): Promise<DelegationResult[]> {
    const tasks = this.spawned.get(parentRunId)
    if (!tasks) return []
    const wanted = [...tasks.values()].filter((t) => !t.collected && (taskId === undefined || t.taskId === taskId))
    if (wait) await Promise.all(wanted.map((t) => t.promise))
    const ready = wanted.filter((t) => t.result !== undefined)
    for (const t of ready) t.collected = true
    return ready.map((t) => t.result!)
  }

  /** Run isolado de um perfil (sem historico) dentro de uma sessao, usado por workflows. Devolve o texto final e o custo. */
  async runIsolated(
    profile: AgentProfile,
    sessionId: string,
    parentRunId: string,
    text: string,
    opts: { policyOverride?: Policy; emit: (event: RunEvent) => void; onApproval: (info: PendingApproval) => void },
  ): Promise<{ text: string; costUsd: number; stop: string; error?: string }> {
    const session = this.store.get(sessionId)
    if (!session) throw new Error(`sessao nao encontrada: ${sessionId}`)
    const req: RunRequest = { sessionId, text, emit: opts.emit, onApproval: opts.onApproval, policyOverride: opts.policyOverride }
    const result = await this.delegate(req, session.workspace, parentRunId, profile.name, text, profile)
    return { text: result.text, costUsd: result.costUsd, stop: result.stop, error: result.error }
  }

  /** Pedido de aprovacao fora de um runner, para etapas de ferramenta de workflow. */
  requestApproval(sessionId: string, runId: string, def: ToolDefinition, args: Record<string, unknown>, onApproval: (info: PendingApproval) => void): Promise<ApprovalDecision> {
    const req: RunRequest = { sessionId, text: '', emit: () => undefined, onApproval, onApprovalPush: true }
    return this.ask(req, runId, { type: 'tool_call', id: randomUUID(), name: def.name, args }, def)
  }

  /** Run filho com outro perfil, sem historico da sessao, custo lancado na mesma sessao sob o run pai. Com worktree, edita em copia isolada. */
  private async delegate(
    req: RunRequest,
    workspace: string,
    parentRunId: string,
    agent: string,
    task: string,
    override?: AgentProfile,
    opts: DelegationOptions & { taskId?: string; runId?: string; background?: boolean } = {},
  ): Promise<DelegationResult & { error?: string }> {
    const child = override ?? this.profile(agent)
    await this.ensureMcp(child)
    const adapter = createAdapter(child)
    const runId = opts.runId ?? randomUUID()
    let worktree: { path: string; branch: string } | undefined
    let childWorkspace = workspace
    if (opts.worktree) {
      if (!isGitRepo(workspace)) throw new Error('worktree exige que o workspace seja um repositorio git')
      worktree = createWorktree(this.config.home, workspace, runId)
      childWorkspace = worktree.path
    }
    req.emit({ type: 'delegation', phase: 'start', agent: child.name, runId, task, taskId: opts.taskId, background: opts.background, worktree })
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
      workspace: childWorkspace,
      approve: (call, def) => this.ask(req, runId, call, def),
      emit: (event) => {
        if (event.type === 'text_delta') text.push(event.delta)
        else if (event.type !== 'run_finished') this.observe(req, runId, event, child, adapter.provider)
      },
      redact: (t) => this.redactor.redact(t),
      hooks: this.hookRunner,
      sandbox: child.sandbox,
      signal: req.signal,
    })
    try {
      const result = await runner.run({ runId, sessionId: req.sessionId, history: [], userText: task, parentRunId })
      this.store.appendMessages(req.sessionId, runId, result.appended, { parentRunId, agent: child.name })
      const last = [...result.appended].reverse().find((m) => m.role === 'assistant')
      const out = { text: (last ? messageText(last) : text.join('')) || text.join(''), costUsd: result.costUsd, runId, stop: result.stop, error: result.error, worktree, taskId: opts.taskId, agent: child.name }
      req.emit({ type: 'delegation', phase: 'end', agent: child.name, runId, task, taskId: opts.taskId, background: opts.background, costUsd: result.costUsd, stop: result.stop, worktree })
      return out
    } catch (err) {
      req.emit({ type: 'delegation', phase: 'end', agent: child.name, runId, task, taskId: opts.taskId, background: opts.background, costUsd: 0, stop: 'error', worktree })
      throw err
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
    if (req.autoApprove && !isDestructive((call.args ?? {}) as Record<string, unknown>)) {
      this.store.recordToolEvent({ sessionId: req.sessionId, runId, name: def.name, args: call.args, decision: 'auto_approved' })
      return 'allow'
    }
    const { info, promise } = this.approvals.request(
      { sessionId: req.sessionId, runId, tool: def.name, args: call.args, risk: def.risk },
      this.config.approvalTimeoutMs,
    )
    this.store.recordApproval(info.id, req.sessionId, runId, def.name, call.args)
    req.onApproval(info)
    if (req.onApprovalPush) {
      void this.push.send({ title: `Aprovar ${def.name}?`, body: JSON.stringify(call.args).slice(0, 120), url: `/session/${req.sessionId}`, tag: `approval-${info.id}` })
    }
    const decision = await promise
    this.store.resolveApproval(info.id, decision)
    return decision
  }

  private observe(req: RunRequest, runId: string, event: RunEvent, profile: AgentProfile, provider: string): void {
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
    this.trace(req.sessionId, runId, event, profile, provider)
    req.emit(event)
  }

  /** Um span por chamada ao modelo e por ferramenta, com atributos das convencoes de GenAI, quando o exportador esta ligado. */
  private trace(sessionId: string, runId: string, event: RunEvent, profile: AgentProfile, provider: string): void {
    if (!this.otel) return
    const now = Date.now()
    const base = { 'agent_hub.session_id': sessionId, 'agent_hub.run_id': runId, 'agent_hub.agent': profile.name }
    if (event.type === 'usage') {
      this.otel.span({
        name: `chat ${event.model}`,
        traceId: traceIdFrom(runId),
        startMs: now - event.latencyMs,
        endMs: now,
        attributes: {
          ...base,
          'gen_ai.operation.name': 'chat',
          'gen_ai.system': provider,
          'gen_ai.request.model': event.model,
          'gen_ai.usage.input_tokens': event.usage.input,
          'gen_ai.usage.output_tokens': event.usage.output + event.usage.reasoning,
          'agent_hub.cache_read_tokens': event.usage.cacheRead,
          'agent_hub.cache_write_tokens': event.usage.cacheWrite,
          'agent_hub.cost_usd': event.costUsd,
          'agent_hub.step': event.step,
        },
      })
    }
    if (event.type === 'tool_result') {
      this.otel.span({
        name: `tool ${event.name}`,
        traceId: traceIdFrom(runId),
        startMs: now - event.ms,
        endMs: now,
        attributes: { ...base, 'gen_ai.tool.name': event.name, 'agent_hub.tool_error': event.isError },
        status: event.isError ? 'error' : 'ok',
      })
    }
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
