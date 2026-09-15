import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import { protocolVersion, type ClientFrame, type ServerFrame } from '@agent-hub/core'
import { registerA2A } from './a2a.js'
import { registrarRotaDeArquivos } from './arquivos.js'
import { Canais } from './canais/index.js'
import { registrarRotasDeCompartilhamento } from './compartilhar.js'
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

  app.get('/pair/local', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: 'so a propria maquina pode pedir o token sem pareamento' })
    const origin = req.headers.origin
    if (!originPermitida(origin, req.headers.host)) return reply.code(403).send({ error: `origem nao permitida: ${origin}` })
    if (origin && origemDeApp(origin)) reply.header('access-control-allow-origin', origin)
    return { url: `ws://${req.headers.host ?? `127.0.0.1:${runtime.config.port}`}/ws`, token, device: runtime.config.deviceName }
  })


  app.get('/media/:hash', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: 'so a propria maquina le a midia' })
    const { hash } = req.params as { hash: string }
    if (!/^[0-9a-f]{64}$/.test(hash)) return reply.code(400).send({ error: 'hash invalido' })
    const guardada = runtime.store.media(hash)
    if (!guardada) return reply.code(404).send({ error: 'midia nao encontrada' })
    return reply.type(guardada.mediaType).header('cache-control', 'private, max-age=31536000, immutable').send(guardada.bytes)
  })
  app.get('/oauth/start', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: 'so a propria maquina inicia autorizacao' })
    const server = (req.query as { server?: string }).server
    if (!server) return reply.code(400).send({ error: 'informe ?server=<nome>' })
    try {
      const url = await runtime.oauth.start(server, redirectUri(req.headers.host, runtime.config.port))
      return reply.redirect(url)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/oauth/callback', async (req, reply) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string }
    if (error) return reply.type('text/html').send(pagina(`Autorizacao recusada: ${error}`))
    if (!code || !state) return reply.code(400).type('text/html').send(pagina('Resposta sem code ou state.'))
    try {
      const server = await runtime.oauth.finish(state, code, redirectUri(req.headers.host, runtime.config.port))
      hub.broadcast({ type: 'mcp.authorized', server })
      return reply.type('text/html').send(pagina(`Servidor ${server} autorizado. Pode fechar esta aba e voltar ao Agent Hub.`))
    } catch (err) {
      return reply.code(400).type('text/html').send(pagina(err instanceof Error ? err.message : String(err)))
    }
  })
  if (runtime.config.webDir) {
    await app.register(fastifyStatic, { root: runtime.config.webDir })
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/ws') || req.url.startsWith('/pair')) return reply.code(404).send({ error: 'nao encontrado' })
      return reply.sendFile('index.html')
    })
    log(`interface em http://${runtime.config.host}:${runtime.config.port}`)
  }

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
  registerA2A(app, runtime, hub, token)
  registrarRotasDeCompartilhamento(app, runtime.convidados, isLoopback)
  registrarRotaDeArquivos(app, runtime, isLoopback)

  await app.listen({ host: runtime.config.host, port: runtime.config.port })
  runtime.onMcpClose = (name) => {
    log(`conector ${name} caiu; reconecta na proxima verificacao`)
    hub.broadcast({ type: 'mcp.servers', servers: hub.serverList() })
  }
  const manterMcp = async (): Promise<void> => {
    const pendentes = runtime.usedMcpServers().filter((n) => !runtime.mcp.connected().includes(n))
    if (pendentes.length === 0) return
    for (const name of pendentes) {
      try {
        await hub.connectMcp(name)
        log(`conector ${name} conectado`)
      } catch (err) {
        log(`conector ${name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    hub.broadcast({ type: 'mcp.servers', servers: hub.serverList() })
  }
  void manterMcp()
  const mcpTimer = setInterval(() => void manterMcp(), 60_000)
  mcpTimer.unref()

  scheduler.start()
  triggers.loadFiles()

  const link = relayFor(runtime.config, relay, hub, triggers, log)
  link?.start()
  runtime.anfitriao.iniciar()
  const canais = new Canais({
    store: runtime.store,
    secrets: runtime.secrets,
    daemonUrl: `ws://127.0.0.1:${runtime.config.port}/ws`,
    daemonToken: token,
    workspacePadrao: runtime.config.workspaces[0] ?? runtime.config.home,
    log,
    mudou: () => hub.broadcast(hub.estadoDosCanais()),
  })
  hub.canais = canais
  canais.iniciar()

  return {
    app,
    hub,
    scheduler,
    triggers,
    async close() {
      link?.stop()
      canais.parar()
      runtime.anfitriao.parar()
      runtime.convidados.parar()
      clearInterval(mcpTimer)
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

/** Endereco da propria maquina, unico caso em que o daemon entrega o token sem pareamento. */
function isLoopback(ip: string): boolean {
  const limpo = ip.replace(/^::ffff:/, '')
  return limpo === '127.0.0.1' || limpo === '::1' || limpo.startsWith('127.')
}

/** Sem origem (app nativo), a propria interface do daemon ou o webview do Tauri. Pagina de outro site nao passa. */
function originPermitida(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  if (origemDeApp(origin)) return true
  return host !== undefined && (origin === `http://${host}` || origin === `https://${host}`)
}

/** Webview do app desktop, que fala com o daemon de outra origem e por isso precisa do cabecalho de CORS. */
function origemDeApp(origin: string): boolean {
  return origin === 'tauri://localhost' || origin === 'https://tauri.localhost' || origin === 'http://tauri.localhost'
}

function redirectUri(host: string | undefined, port: number): string {
  return `http://${host ?? `127.0.0.1:${port}`}/oauth/callback`
}

function pagina(mensagem: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Agent Hub</title><body style="font-family: system-ui; padding: 40px; background: #15171c; color: #e8e9ec"><p>${mensagem}</p></body>`
}
