import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { protocolVersion, resolveInside, type ClientFrame, type RunMode, type ServerFrame } from '@agent-hub/core'
import { autoAgent, draftPolicy, type Runtime } from './runtime.js'
import type { Scheduler } from './schedules.js'
import type { Triggers } from './triggers.js'
import { WorkflowEngine } from './workflows.js'

export interface Conn {
  send(frame: ServerFrame): void
  authed: boolean
  client: string
}

/** Trata os quadros do protocolo para qualquer conexao, seja socket local ou canal vindo do relay. */
export class ConnectionHub {
  private readonly conns = new Set<Conn>()
  private readonly runs = new Map<string, AbortController>()
  scheduler!: Scheduler
  triggers!: Triggers
  readonly workflows: WorkflowEngine

  constructor(
    private readonly runtime: Runtime,
    private readonly token: string,
  ) {
    this.workflows = new WorkflowEngine(runtime, (f) => this.broadcast(f))
  }

  attach(conn: Conn): void {
    this.conns.add(conn)
  }

  detach(conn: Conn): void {
    this.conns.delete(conn)
  }

  broadcast = (frame: ServerFrame): void => {
    for (const c of this.conns) if (c.authed) safeSend(c, frame)
  }

  abortAll(): void {
    for (const c of this.runs.values()) c.abort()
  }

  async handle(conn: Conn, frame: ClientFrame): Promise<void> {
    try {
      await this.dispatch(conn, frame)
    } catch (err) {
      conn.send({ type: 'error', message: describe(err), ref: frame.type })
    }
  }

  private async dispatch(conn: Conn, frame: ClientFrame): Promise<void> {
    const runtime = this.runtime
    const send = (f: ServerFrame) => conn.send(f)
    if (frame.type === 'auth') {
      if (frame.protocol_version !== protocolVersion) {
        send({ type: 'auth.error', message: `protocolo ${frame.protocol_version} incompativel com ${protocolVersion}` })
        return
      }
      if (!safeEqual(frame.token, this.token)) {
        send({ type: 'auth.error', message: 'token invalido' })
        return
      }
      conn.authed = true
      conn.client = frame.client
      send({ type: 'auth.ok', protocol_version: protocolVersion, device: runtime.config.deviceName })
      return
    }
    if (!conn.authed) {
      send({ type: 'auth.error', message: 'autentique primeiro' })
      return
    }
    switch (frame.type) {
      case 'agents.list':
        send({ type: 'agents.list', agents: runtime.agents(), errors: runtime.repo.errors })
        return
      case 'session.create': {
        const workspace = runtime.assertWorkspace(frame.workspace)
        const agent = frame.agent === undefined || frame.agent === autoAgent ? autoAgent : runtime.profile(frame.agent).name
        const session = runtime.store.create(agent, workspace, frame.title)
        send({ type: 'session.created', session })
        this.broadcast({ type: 'session.updated', session })
        return
      }
      case 'feedback.set': {
        runtime.setFeedback(frame.session_id, frame.run_id, frame.verdict)
        this.broadcast({ type: 'feedback.ok', session_id: frame.session_id, run_id: frame.run_id, verdict: frame.verdict })
        return
      }
      case 'feedback.list':
        send({ type: 'feedback.list', session_id: frame.session_id, items: runtime.feedbackList(frame.session_id) })
        return
      case 'feedback.summary':
        send({ type: 'feedback.summary', rows: runtime.feedbackSummary() })
        return
      case 'stats.overview':
        send({ type: 'stats.overview', stats: runtime.statsOverview(frame.days) })
        return
      case 'routing.info':
        send({
          type: 'routing.info',
          default_agent: runtime.repo.routing.default_agent ?? null,
          improver: runtime.repo.routing.prompt_improver?.agent ?? null,
          classifier: runtime.repo.routing.classifier?.agent ?? null,
        })
        return
      case 'session.list':
        send({ type: 'session.list', sessions: runtime.store.list(frame.limit, frame.include_archived) })
        return
      case 'session.update': {
        const agent = frame.agent === undefined ? undefined : frame.agent === autoAgent ? autoAgent : runtime.profile(frame.agent).name
        const session = runtime.store.update(frame.session_id, { title: frame.title, pinned: frame.pinned, archived: frame.archived, agent, mode: frame.mode })
        if (!session) throw new Error('sessao nao encontrada')
        if (frame.mode === 'auto_approve') {
          for (const id of runtime.flushApprovals(frame.session_id)) this.broadcast({ type: 'approval.resolved', approval_id: id, decision: 'allow' })
        }
        this.broadcast({ type: 'session.updated', session })
        return
      }
      case 'session.delete': {
        if (this.runs.size > 0) {
          for (const [, c] of this.runs) c.signal.aborted
        }
        if (!runtime.store.delete(frame.session_id)) throw new Error('sessao nao encontrada')
        this.broadcast({ type: 'session.deleted', session_id: frame.session_id })
        return
      }
      case 'session.fork': {
        const session = runtime.store.fork(frame.session_id)
        if (!session) throw new Error('sessao nao encontrada')
        send({ type: 'session.created', session })
        this.broadcast({ type: 'session.updated', session })
        return
      }
      case 'session.get': {
        const session = runtime.store.get(frame.session_id)
        if (!session) throw new Error('sessao nao encontrada')
        send({
          type: 'session.get',
          session,
          messages: runtime.store.history(frame.session_id),
          children: runtime.store.children(frame.session_id).map((c) => ({ run_id: c.runId, parent_run_id: c.parentRunId, agent: c.agent, messages: c.messages })),
        })
        return
      }
      case 'sync':
        send({ type: 'sync', session_id: frame.session_id, events: runtime.store.eventsSince(frame.session_id, frame.since_seq) })
        return
      case 'run.start':
        this.startRun(frame.session_id, frame.text, send, frame.mode, frame.reasoning, frame.agent, frame.improve)
        return
      case 'cost.status': {
        const s = runtime.costStatus()
        send({
          type: 'cost.status',
          today_usd: s.todayUsd,
          month_usd: s.monthUsd,
          global_month_limit_usd: s.globalMonthLimit,
          agents: Object.fromEntries(Object.entries(s.agents).map(([k, v]) => [k, { today_usd: v.todayUsd, day_limit_usd: v.dayLimit }])),
        })
        return
      }
      case 'cost.export': {
        const out = runtime.ledger.exportCsv({ since: frame.since, until: frame.until })
        send({ type: 'cost.export', csv: out.csv, rows: out.rows })
        return
      }
      case 'run.cancel':
        this.runs.get(frame.run_id)?.abort()
        return
      case 'approval.respond': {
        const ok = runtime.approvals.respond(frame.approval_id, frame.decision)
        if (!ok) throw new Error('aprovacao nao encontrada ou expirada')
        this.broadcast({ type: 'approval.resolved', approval_id: frame.approval_id, decision: frame.decision })
        return
      }
      case 'cost.report':
        send({ type: 'cost.report', rows: runtime.ledger.report(frame.group, { since: frame.since }) })
        return
      case 'budget.override': {
        const ok = runtime.overrideBudget(frame.run_id, frame.scope, frame.limit_usd)
        if (!ok) throw new Error('run nao esta ativo')
        this.broadcast({ type: 'budget.overridden', run_id: frame.run_id, scope: frame.scope, limit_usd: frame.limit_usd })
        return
      }
      case 'schedule.list':
        send({ type: 'schedule.list', schedules: this.scheduler.list(), paused: this.scheduler.paused })
        return
      case 'schedule.upsert':
        this.scheduler.upsert(frame.schedule)
        return
      case 'schedule.delete':
        if (!this.scheduler.delete(frame.id)) throw new Error('agendamento nao encontrado')
        return
      case 'schedule.run_now':
        void this.scheduler.runNow(frame.id).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
        return
      case 'automation.pause':
        runtime.automation.setPaused(true)
        return
      case 'automation.resume':
        runtime.automation.setPaused(false)
        return
      case 'automation.runs':
        send({ type: 'automation.runs', runs: runtime.automation.runs(frame.automation_id, frame.limit) })
        return
      case 'trigger.list':
        send({ type: 'trigger.list', triggers: this.triggers.list() })
        return
      case 'trigger.upsert':
        this.triggers.upsert(frame.trigger)
        return
      case 'trigger.delete':
        if (!this.triggers.delete(frame.id)) throw new Error('gatilho nao encontrado')
        return
      case 'mcp.servers': {
        const connected = new Set(runtime.mcp.connected())
        send({
          type: 'mcp.servers',
          servers: Object.entries(runtime.repo.mcp.servers).map(([name, cfg]) => ({ name, connected: connected.has(name), transport: cfg.url ? 'http' : 'stdio' })),
        })
        return
      }
      case 'mcp.resources':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.resources', server: frame.server, resources: await runtime.mcp.resources(frame.server) })
        return
      case 'mcp.resource.read':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.resource.read', server: frame.server, uri: frame.uri, text: await runtime.mcp.readResource(frame.server, frame.uri) })
        return
      case 'mcp.prompts':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.prompts', server: frame.server, prompts: await runtime.mcp.prompts(frame.server) })
        return
      case 'mcp.prompt.get':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.prompt.get', server: frame.server, name: frame.name, text: await runtime.mcp.getPrompt(frame.server, frame.name, frame.args ?? {}) })
        return
      case 'push.vapid':
        send({ type: 'push.vapid', public_key: runtime.push.publicKey, subscriptions: runtime.push.count() })
        return
      case 'push.subscribe':
        runtime.push.subscribe(frame.subscription, conn.client)
        send({ type: 'push.subscribed', endpoint: frame.subscription.endpoint })
        return
      case 'push.unsubscribe':
        runtime.push.unsubscribe(frame.endpoint)
        return
      case 'push.test':
        await runtime.push.send({ title: 'Agent Hub', body: `Notificacoes ativas em ${runtime.config.deviceName}`, tag: 'teste' })
        return
      case 'workflow.list':
        send({ type: 'workflow.list', workflows: this.workflows.list() })
        return
      case 'secrets.list':
        send({ type: 'secrets.list', secrets: runtime.secrets.list().map((s) => ({ name: s.name, hint: s.hint, length: s.length, updated_at: s.updatedAt, source: s.source })) })
        return
      case 'secrets.set':
        runtime.secrets.set(frame.name, frame.value)
        send({ type: 'secrets.list', secrets: runtime.secrets.list().map((s) => ({ name: s.name, hint: s.hint, length: s.length, updated_at: s.updatedAt, source: s.source })) })
        return
      case 'fs.list': {
        const workspace = this.workspaceOf(frame.session_id)
        const dir = resolveInside(workspace, frame.path ?? '.')
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => !['node_modules', '.git', 'dist', 'vendor'].includes(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        send({ type: 'fs.list', path: relative(workspace, dir) || '.', entries })
        return
      }
      case 'fs.read': {
        const workspace = this.workspaceOf(frame.session_id)
        const file = resolveInside(workspace, frame.path)
        const max = frame.max_chars ?? 60_000
        const raw = readFileSync(file, 'utf8')
        send({ type: 'fs.read', path: relative(workspace, file), text: raw.slice(0, max), truncated: raw.length > max })
        return
      }
      case 'fs.tree': {
        const workspace = this.workspaceOf(frame.session_id)
        const dir = resolveInside(workspace, frame.path ?? '.')
        send({ type: 'fs.tree', path: relative(workspace, dir) || '.', text: tree(dir, frame.depth ?? 3) })
        return
      }
      case 'skills.list': {
        const allowed = frame.agent ? new Set(runtime.profile(frame.agent).skills) : null
        send({
          type: 'skills.list',
          skills: [...runtime.repo.skills.values()]
            .filter((s) => !allowed || allowed.has(s.name))
            .map((s) => ({ name: s.name, description: s.description, source: s.name.includes(':') ? 'plugin' : 'agents' })),
        })
        return
      }
      case 'skill.get': {
        const skill = runtime.repo.skills.get(frame.name)
        if (!skill) throw new Error(`skill desconhecida: ${frame.name}`)
        send({ type: 'skill.get', name: skill.name, body: skill.body })
        return
      }
      case 'plugins.list':
        send({
          type: 'plugins.list',
          plugins: runtime.repo.plugins.map((p) => ({ name: p.name, dir: p.dir, skills: p.skills.size, agents: p.profiles.size, mcp: Object.keys(p.mcp).length, hooks: p.hooks.length })),
        })
        return
      case 'secrets.delete':
        runtime.secrets.delete(frame.name)
        send({ type: 'secrets.list', secrets: runtime.secrets.list().map((s) => ({ name: s.name, hint: s.hint, length: s.length, updated_at: s.updatedAt, source: s.source })) })
        return
      case 'workflow.run':
        void this.workflows.run({ name: frame.name, inputs: frame.inputs, workspace: frame.workspace }).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
        return
    }
  }

  private workspaceOf(sessionId: string): string {
    const session = this.runtime.store.get(sessionId)
    if (!session) throw new Error('sessao nao encontrada')
    return session.workspace
  }

  private async connectMcp(name: string): Promise<void> {
    const config = this.runtime.repo.mcp.servers[name]
    if (!config) throw new Error(`servidor MCP nao configurado: ${name}`)
    this.runtime.registry.registerAll(await this.runtime.mcp.connect(name, config))
  }

  private startRun(
    sessionId: string,
    text: string,
    send: (f: ServerFrame) => void,
    mode: RunMode = 'normal',
    reasoning?: 'low' | 'medium' | 'high' | 'max',
    agent?: string,
    improve?: boolean,
  ): void {
    const runtime = this.runtime
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, controller)
    send({ type: 'run.started', run_id: runId, session_id: sessionId })
    runtime.store.update(sessionId, { mode })
    const policyOverride = mode === 'draft' ? draftPolicy : mode === 'accept_edits' ? { read: 'allow' as const, write: 'allow' as const, exec: 'ask' as const } : undefined
    void runtime
      .run({
        sessionId,
        text,
        runId,
        signal: controller.signal,
        policyOverride,
        autoApprove: mode === 'auto_approve',
        reasoningOverride: reasoning,
        agentOverride: agent && agent !== autoAgent ? agent : undefined,
        improve,
        emit: (event) => {
          const seq = runtime.store.appendEvent(sessionId, runId, event)
          this.broadcast({ type: 'event', session_id: sessionId, run_id: runId, seq, event })
          if (event.type === 'run_finished') {
            void runtime.hooks.emit('run.end', { session_id: sessionId, run_id: runId, stop: event.stop, cost_usd: event.costUsd, steps: event.steps })
            if (event.stop === 'budget_exceeded') void runtime.hooks.emit('budget.exceeded', { session_id: sessionId, run_id: runId, message: event.error ?? '' })
            void runtime.push.send({
              title: `Run ${event.stop === 'end' ? 'concluido' : event.stop}`,
              body: `${event.steps} passos, ${event.costUsd.toFixed(4)} USD`,
              url: `/session/${sessionId}`,
              tag: `run-${runId}`,
            })
          }
        },
        onApproval: (info) => {
          const frame: ServerFrame = {
            type: 'approval.required',
            approval_id: info.id,
            session_id: info.sessionId,
            run_id: info.runId,
            tool: info.tool,
            args: info.args,
            risk: info.risk,
            expires_at: info.expiresAt,
          }
          this.broadcast(frame)
          void runtime.hooks.emit('approval.required', { approval_id: info.id, session_id: info.sessionId, tool: info.tool, risk: info.risk, expires_at: info.expiresAt })
          void runtime.push.send({
            title: `Aprovar ${info.tool}?`,
            body: JSON.stringify(info.args).slice(0, 120),
            url: `/session/${info.sessionId}`,
            tag: `approval-${info.id}`,
          })
        },
      })
      .catch((err: unknown) => this.broadcast({ type: 'error', message: describe(err), ref: runId }))
      .finally(() => {
        this.runs.delete(runId)
        const session = runtime.store.get(sessionId)
        if (session) this.broadcast({ type: 'session.updated', session })
      })
  }
}

/** Arvore de diretorios em texto, limitada em profundidade e em 400 linhas. */
function tree(dir: string, depth: number): string {
  const lines: string[] = []
  const skip = new Set(['node_modules', '.git', 'dist', 'vendor', '.next', 'build', 'target'])
  const walk = (d: string, prefix: string, level: number) => {
    if (level > depth || lines.length > 400) return
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (skip.has(e.name)) continue
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`)
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}  `, level + 1)
    }
  }
  walk(dir, '', 1)
  return lines.join('\n')
}

function safeSend(conn: Conn, frame: ServerFrame): void {
  try {
    conn.send(frame)
  } catch {
    return
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
