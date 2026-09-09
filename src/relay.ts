import WebSocket from 'ws'
import { relayHeaders, type DaemonToRelay, type RelayToDaemon, type ServerFrame } from '@agent-hub/core'
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

/** Mantem a conexao de saida com o relay e traduz cada canal em uma conexao do hub. */
export class RelayLink {
  private socket: WebSocket | null = null
  private channels = new Map<string, Conn>()
  private attempts = 0
  private stopped = false

  constructor(
    private readonly opts: RelayLinkOptions,
    private readonly hub: ConnectionHub,
    private readonly onTrigger: (triggerId: string, headers: Record<string, string>, body: string) => FireResult,
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
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
      this.opts.log(`relay conectado em ${this.opts.url}`)
    })
    socket.on('message', (raw) => this.receive(JSON.parse(String(raw)) as RelayToDaemon))
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

  private receive(msg: RelayToDaemon): void {
    switch (msg.t) {
      case 'open': {
        const conn: Conn = { authed: false, client: msg.client, send: (frame: ServerFrame) => this.send({ t: 'frame', ch: msg.ch, frame }) }
        this.channels.set(msg.ch, conn)
        this.hub.attach(conn)
        return
      }
      case 'frame': {
        const conn = this.channels.get(msg.ch)
        if (conn) void this.hub.handle(conn, msg.frame)
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

  private send(msg: DaemonToRelay): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg))
  }
}
