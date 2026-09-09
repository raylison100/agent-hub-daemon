import { randomUUID, timingSafeEqual } from 'node:crypto'
import { protocolVersion, type ClientFrame, type ServerFrame } from '@agent-hub/core'
import { draftPolicy, type Runtime } from './runtime.js'
import type { Scheduler } from './schedules.js'
import type { Triggers } from './triggers.js'

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

  constructor(
    private readonly runtime: Runtime,
    private readonly token: string,
  ) {}

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
        const { agent, routed } = await runtime.resolveAgent(frame.agent, frame.text ?? frame.title ?? '', workspace)
        const session = runtime.store.create(agent, workspace, frame.title)
        send({ type: 'session.created', session, routed: routed ? { intent: routed.intent, rule: routed.rule } : undefined })
        this.broadcast({ type: 'session.updated', session })
        return
      }
      case 'session.list':
        send({ type: 'session.list', sessions: runtime.store.list(frame.limit) })
        return
      case 'session.get': {
        const session = runtime.store.get(frame.session_id)
        if (!session) throw new Error('sessao nao encontrada')
        send({ type: 'session.get', session, messages: runtime.store.history(frame.session_id) })
        return
      }
      case 'sync':
        send({ type: 'sync', session_id: frame.session_id, events: runtime.store.eventsSince(frame.session_id, frame.since_seq) })
        return
      case 'run.start':
        this.startRun(frame.session_id, frame.text, send, frame.mode)
        return
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
    }
  }

  private async connectMcp(name: string): Promise<void> {
    const config = this.runtime.repo.mcp.servers[name]
    if (!config) throw new Error(`servidor MCP nao configurado: ${name}`)
    this.runtime.registry.registerAll(await this.runtime.mcp.connect(name, config))
  }

  private startRun(sessionId: string, text: string, send: (f: ServerFrame) => void, mode: 'normal' | 'draft' | 'auto_approve' = 'normal'): void {
    const runtime = this.runtime
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, controller)
    send({ type: 'run.started', run_id: runId, session_id: sessionId })
    void runtime
      .run({
        sessionId,
        text,
        runId,
        signal: controller.signal,
        policyOverride: mode === 'draft' ? draftPolicy : undefined,
        autoApprove: mode === 'auto_approve',
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
