import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'smol-toml'

export interface DaemonConfig {
  home: string
  agentsDir: string
  dbPath: string
  host: string
  port: number
  workspaces: string[]
  approvalTimeoutMs: number
  deviceName: string
}

interface RawConfig {
  agents_dir?: string
  db_path?: string
  host?: string
  port?: number
  workspaces?: string[]
  approval_timeout_ms?: number
  device_name?: string
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
  }
}

/** Garante o token local de acesso ao daemon, gravado com permissao restrita ao usuario. */
export function ensureToken(home: string): string {
  const file = join(home, 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const token = randomBytes(32).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
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
    '',
  ].join('\n')
}
