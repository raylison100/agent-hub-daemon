import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { parseOtelHeaders } from './otel.js'

export interface DaemonConfig {
  home: string
  agentsDir: string
  dbPath: string
  host: string
  port: number
  workspaces: string[]
  approvalTimeoutMs: number
  deviceName: string
  relayUrl?: string
  otelEndpoint?: string
  otelHeaders: Record<string, string>
}

interface RawConfig {
  agents_dir?: string
  db_path?: string
  host?: string
  port?: number
  workspaces?: string[]
  approval_timeout_ms?: number
  device_name?: string
  relay_url?: string
  otel_endpoint?: string
  otel_headers?: Record<string, string>
}

export function configHome(): string {
  return process.env.AGENT_HUB_HOME ?? join(homedir(), '.agent-hub')
}

/** Le `~/.agent-hub/config.toml` com padroes seguros: apenas localhost e nenhum workspace liberado. */
export function loadConfig(): DaemonConfig {
  const home = configHome()
  mkdirSync(home, { recursive: true })
  const file = join(home, 'config.toml')
  const raw: RawConfig = existsSync(file) ? (parse(readFileSync(file, 'utf8')) as RawConfig) : {}
  return {
    home,
    agentsDir: resolve(process.env.AGENT_HUB_AGENTS ?? raw.agents_dir ?? join(home, 'agents')),
    dbPath: resolve(raw.db_path ?? join(home, 'agent-hub.sqlite')),
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 47311,
    workspaces: (raw.workspaces ?? []).map((w) => resolve(w)),
    approvalTimeoutMs: raw.approval_timeout_ms ?? 10 * 60 * 1000,
    deviceName: raw.device_name ?? 'este-computador',
    relayUrl: process.env.AGENT_HUB_RELAY_URL ?? raw.relay_url,
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? raw.otel_endpoint,
    otelHeaders: process.env.OTEL_EXPORTER_OTLP_HEADERS ? parseOtelHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) : (raw.otel_headers ?? {}),
  }
}

/** Token de conta usado no relay para agrupar dispositivos e clientes da mesma pessoa. */
export function ensureAccountToken(home: string): string {
  return ensureSecretFile(join(home, 'account_token'), () => randomBytes(32).toString('hex'))
}

/** Identificador estavel deste daemon no relay. */
export function ensureDeviceId(home: string): string {
  return ensureSecretFile(join(home, 'device_id'), () => randomUUID())
}

function ensureSecretFile(file: string, generate: () => string): string {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const value = generate()
  writeFileSync(file, value, { mode: 0o600 })
  chmodSync(file, 0o600)
  return value
}

/** Garante o token local de acesso ao daemon, gravado com permissao restrita ao usuario. */
export function ensureToken(home: string): string {
  return ensureSecretFile(join(home, 'token'), () => randomBytes(32).toString('hex'))
}

export function exampleConfig(): string {
  return [
    '# ~/.agent-hub/config.toml',
    'agents_dir = "/home/usuario/Projects/agent-hub/agents"',
    'host = "127.0.0.1"',
    'port = 47311',
    'workspaces = ["/home/usuario/Projects/meu-projeto"]',
    'approval_timeout_ms = 600000',
    'device_name = "pc-casa"',
    '# relay_url = "wss://relay.exemplo.com"',
    '# otel_endpoint = "http://localhost:4318"',
    '# [otel_headers]',
    '# authorization = "Bearer ..."',
    '',
  ].join('\n')
}
