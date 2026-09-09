import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { protocolVersion, type ClientFrame, type ServerFrame } from '@agent-hub/core'
import type { Runtime } from './runtime.js'
import { Scheduler } from './schedules.js'

interface Conn {
  socket: WebSocket
  authed: boolean
  client: string
}

export interface ServerHandle {
  app: FastifyInstance
  scheduler: Scheduler
  close(): Promise<void>
}

/** Sobe o servidor WebSocket local do daemon e trata os quadros do protocolo. */
export async function startServer(runtime: Runtime, token: string): Promise<ServerHandle> {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  const conns = new Set<Conn>()
  const runs = new Map<string, AbortController>()

  const broadcast = (frame: ServerFrame) => {
    const data = JSON.stringify(frame)
    for (const c of conns) if (c.authed && c.socket.readyState === c.socket.OPEN) c.socket.send(data)
  }
  const scheduler = new Scheduler(runtime, runtime.db, broadcast)

  app.get('/health', async () => ({ ok: true, device: runtime.config.deviceName, protocol_version: protocolVersion }))

  app.get('/ws', { websocket: true }, (socket) => {
    const conn: Conn = { socket, authed: false, client: '' }
    conns.add(conn)
    const send = (frame: ServerFrame) => socket.send(JSON.stringify(frame))
    socket.on('close', () => conns.delete(conn))
    socket.on('message', (raw) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(String(raw)) as ClientFrame
      } catch {
        send({ type: 'error', message: 'quadro invalido' })
        return
      }
      void handle(conn, frame, send).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
    })
  })

  async function handle(conn: Conn, frame: ClientFrame, send: (f: ServerFrame) => void): Promise<void> {
    if (frame.type === 'auth') {
      if (frame.protocol_version !== protocolVersion) {
        send({ type: 'auth.error', message: `protocolo ${frame.protocol_version} incompativel com ${protocolVersion}` })
        return
      }
      if (!safeEqual(frame.token, token)) {
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
        const { agent, routed } = runtime.resolveAgent(frame.agent, frame.text ?? frame.title ?? '', workspace)
        const session = runtime.store.create(agent, workspace, frame.title)
        send({ type: 'session.created', session, routed: routed ? { intent: routed.intent, rule: routed.rule } : undefined })
        broadcast({ type: 'session.updated', session })
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
      case 'run.start': {
        const runId = randomUUID()
        const controller = new AbortController()
        runs.set(runId, controller)
        send({ type: 'run.started', run_id: runId, session_id: frame.session_id })
        void runtime
          .run({
            sessionId: frame.session_id,
            text: frame.text,
            runId,
            signal: controller.signal,
            emit: (event) => {
              const seq = runtime.store.appendEvent(frame.session_id, runId, event)
              broadcast({ type: 'event', session_id: frame.session_id, run_id: runId, seq, event })
            },
            onApproval: (info) =>
              broadcast({
                type: 'approval.required',
                approval_id: info.id,
                session_id: info.sessionId,
                run_id: info.runId,
                tool: info.tool,
                args: info.args,
                risk: info.risk,
                expires_at: info.expiresAt,
              }),
          })
          .catch((err: unknown) => broadcast({ type: 'error', message: describe(err), ref: runId }))
          .finally(() => {
            runs.delete(runId)
            const session = runtime.store.get(frame.session_id)
            if (session) broadcast({ type: 'session.updated', session })
          })
        return
      }
      case 'run.cancel':
        runs.get(frame.run_id)?.abort()
        return
      case 'approval.respond': {
        const ok = runtime.approvals.respond(frame.approval_id, frame.decision)
        if (!ok) throw new Error('aprovacao nao encontrada ou expirada')
        broadcast({ type: 'approval.resolved', approval_id: frame.approval_id, decision: frame.decision })
        return
      }
      case 'cost.report':
        send({ type: 'cost.report', rows: runtime.ledger.report(frame.group, { since: frame.since }) })
        return
      case 'budget.override': {
        const ok = runtime.overrideBudget(frame.run_id, frame.scope, frame.limit_usd)
        if (!ok) throw new Error('run nao esta ativo')
        broadcast({ type: 'budget.overridden', run_id: frame.run_id, scope: frame.scope, limit_usd: frame.limit_usd })
        return
      }
      case 'schedule.list':
        send({ type: 'schedule.list', schedules: scheduler.list(), paused: scheduler.paused })
        return
      case 'schedule.upsert':
        scheduler.upsert(frame.schedule)
        return
      case 'schedule.delete':
        if (!scheduler.delete(frame.id)) throw new Error('agendamento nao encontrado')
        return
      case 'schedule.run_now':
        void scheduler.runNow(frame.id).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
        return
      case 'automation.pause':
        scheduler.setPaused(true)
        return
      case 'automation.resume':
        scheduler.setPaused(false)
        return
      case 'automation.runs':
        send({ type: 'automation.runs', runs: scheduler.runs(frame.automation_id, frame.limit) })
        return
    }
  }

  await app.listen({ host: runtime.config.host, port: runtime.config.port })
  scheduler.start()
  return {
    app,
    scheduler,
    async close() {
      scheduler.stop()
      for (const c of runs.values()) c.abort()
      await runtime.mcp.close()
      await app.close()
    },
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
