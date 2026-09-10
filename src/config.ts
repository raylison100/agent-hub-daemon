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

/** Carrega `~/.agent-hub/.env` no ambiente do processo sem sobrescrever variaveis ja definidas. */
export function loadDotEnv(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = join(home, '.env')
  if (!existsSync(file)) return []
  const loaded: string[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i <= 0) continue
    const key = line.slice(0, i).trim().replace(/^export\s+/, '')
    let value = line.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (env[key] === undefined && value !== '') {
      env[key] = value
      loaded.push(key)
    }
  }
  return loaded
}

export const envTemplate = [
  '# Chaves lidas pelo daemon no inicio. Nao versionar este arquivo.',
  '# Variaveis ja definidas no ambiente tem prioridade sobre estas.',
  'ANTHROPIC_API_KEY=',
  'DEEPSEEK_API_KEY=',
  'OPENAI_API_KEY=',
  '',
  '# Servidores MCP referenciam variaveis por nome em agents/mcp.json, por exemplo:',
  '# GITLAB_TOKEN=',
  '',
  '# Gatilhos externos: um segredo por gatilho, referenciado em secret_ref',
  '# TRIGGER_MR_SECRET=',
  '',
].join('\n')

/** Le `~/.agent-hub/config.toml` com padroes seguros: apenas localhost e nenhum workspace liberado. */
export function loadConfig(): DaemonConfig {
  const home = configHome()
  mkdirSync(home, { recursive: true })
  loadDotEnv(home)
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
