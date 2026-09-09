import WebSocket from 'ws'
import {
  deriveE2eKey,
  isSealed,
  openFrame,
  relayHeaders,
  sealFrame,
  type ClientFrame,
  type DaemonToRelay,
  type RelayToDaemon,
  type ServerFrame,
} from '@agent-hub/core'
import type { Conn, ConnectionHub } from './hub.js'
import type { FireResult } from './triggers.js'

export interface RelayLinkOptions {
  url: string
  accountToken: string
  deviceId: string
  deviceName: string
  log: (message: string) => void
}

const backoffMs = [2000, 5000, 10000, 30000]

/** Mantem a conexao de saida com o relay, cifra os quadros de ponta a ponta e traduz cada canal em uma conexao do hub. */
export class RelayLink {
  private socket: WebSocket | null = null
  private channels = new Map<string, Conn>()
  private attempts = 0
  private stopped = false
  private key: CryptoKey | null = null

  constructor(
    private readonly opts: RelayLinkOptions,
    private readonly hub: ConnectionHub,
    private readonly onTrigger: (triggerId: string, headers: Record<string, string>, body: string) => FireResult,
  ) {}

  start(): void {
    this.stopped = false
    void deriveE2eKey(this.opts.accountToken).then((key) => {
      this.key = key
      this.connect()
    })
  }

  stop(): void {
    this.stopped = true
    this.socket?.close()
  }

  private connect(): void {
    const url = new URL(this.opts.url)
    url.pathname = url.pathname.replace(/\/$/, '') + '/device'
    const socket = new WebSocket(url, {
      headers: {
        [relayHeaders.accountToken]: this.opts.accountToken,
        [relayHeaders.deviceId]: this.opts.deviceId,
        [relayHeaders.deviceName]: this.opts.deviceName,
      },
    })
    this.socket = socket
    socket.on('open', () => {
      this.attempts = 0
      this.opts.log(`relay conectado em ${this.opts.url} (quadros cifrados de ponta a ponta)`)
    })
    socket.on('message', (raw) => void this.receive(JSON.parse(String(raw)) as RelayToDaemon))
    socket.on('error', (err) => this.opts.log(`relay: ${err.message}`))
    socket.on('close', () => {
      for (const conn of this.channels.values()) this.hub.detach(conn)
      this.channels.clear()
      if (this.stopped) return
      const delay = backoffMs[Math.min(this.attempts, backoffMs.length - 1)]!
      this.attempts += 1
      setTimeout(() => this.connect(), delay)
    })
  }

  private async receive(msg: RelayToDaemon): Promise<void> {
    switch (msg.t) {
      case 'open': {
        const conn: Conn = { authed: false, client: msg.client, send: (frame: ServerFrame) => void this.sendFrame(msg.ch, frame) }
        this.channels.set(msg.ch, conn)
        this.hub.attach(conn)
        return
      }
      case 'frame': {
        const conn = this.channels.get(msg.ch)
        if (!conn) return
        try {
          const frame = isSealed(msg.frame) ? await openFrame<ClientFrame>(this.key!, msg.frame) : msg.frame
          void this.hub.handle(conn, frame)
        } catch {
          conn.send({ type: 'error', message: 'quadro cifrado invalido' })
        }
        return
      }
      case 'close': {
        const conn = this.channels.get(msg.ch)
        if (conn) this.hub.detach(conn)
        this.channels.delete(msg.ch)
        return
      }
      case 'trigger': {
        const result = this.onTrigger(msg.trigger_id, msg.headers, msg.body)
        this.send({ t: 'trigger_result', id: msg.id, accepted: result.accepted, reason: result.reason })
        return
      }
      case 'ping':
        this.send({ t: 'pong' })
        return
    }
  }

  private async sendFrame(ch: string, frame: ServerFrame): Promise<void> {
    this.send({ t: 'frame', ch, frame: this.key ? await sealFrame(this.key, frame) : frame })
  }

  private send(msg: DaemonToRelay): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg))
  }
}
