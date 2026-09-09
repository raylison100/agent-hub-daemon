import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { protocolVersion, type ClientFrame, type ServerFrame } from '@agent-hub/core'
import { AutomationRunner } from './automation.js'
import type { DaemonConfig } from './config.js'
import { ConnectionHub, type Conn } from './hub.js'
import { RelayLink } from './relay.js'
import type { Runtime } from './runtime.js'
import { Scheduler } from './schedules.js'
import { Triggers } from './triggers.js'

export interface ServerHandle {
  app: FastifyInstance
  hub: ConnectionHub
  scheduler: Scheduler
  triggers: Triggers
  close(): Promise<void>
}

export interface RelayCredentials {
  accountToken: string
  deviceId: string
}

/** Sobe o servidor WebSocket local, o agendador, os gatilhos e, quando configurado, o link com o relay. */
export async function startServer(runtime: Runtime, token: string, relay?: RelayCredentials, log: (m: string) => void = console.log): Promise<ServerHandle> {
  const app = Fastify({ logger: false })
  await app.register(websocket)
  const hub = new ConnectionHub(runtime, token)
  const automation = new AutomationRunner(runtime, runtime.db, hub.broadcast)
  runtime.automation = automation
  const scheduler = new Scheduler(runtime, runtime.db, automation, hub.broadcast)
  const triggers = new Triggers(runtime, runtime.db, automation, hub.broadcast)
  hub.scheduler = scheduler
  hub.triggers = triggers

  app.get('/health', async () => ({ ok: true, device: runtime.config.deviceName, protocol_version: protocolVersion }))

  app.get('/ws', { websocket: true }, (socket) => {
    const conn: Conn = { authed: false, client: '', send: (frame: ServerFrame) => socket.send(JSON.stringify(frame)) }
    hub.attach(conn)
    socket.on('close', () => hub.detach(conn))
    socket.on('message', (raw) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(String(raw)) as ClientFrame
      } catch {
        conn.send({ type: 'error', message: 'quadro invalido' })
        return
      }
      void hub.handle(conn, frame)
    })
  })

  await app.listen({ host: runtime.config.host, port: runtime.config.port })
  scheduler.start()
  triggers.loadFiles()

  const link = relayFor(runtime.config, relay, hub, triggers, log)
  link?.start()

  return {
    app,
    hub,
    scheduler,
    triggers,
    async close() {
      link?.stop()
      scheduler.stop()
      hub.abortAll()
      await runtime.mcp.close()
      await app.close()
    },
  }
}

function relayFor(config: DaemonConfig, relay: RelayCredentials | undefined, hub: ConnectionHub, triggers: Triggers, log: (m: string) => void): RelayLink | null {
  if (!config.relayUrl || !relay) return null
  return new RelayLink(
    { url: config.relayUrl, accountToken: relay.accountToken, deviceId: relay.deviceId, deviceName: config.deviceName, log },
    hub,
    (id, headers, body) => triggers.fire(id, headers, body),
  )
}
