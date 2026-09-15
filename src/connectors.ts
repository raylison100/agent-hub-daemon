import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpFileSchema, type McpServerConfig } from '@agent-hub/core'

interface RawServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  type?: string
}

export interface SaveResult {
  added: string[]
  secrets: string[]
}

const secretHints = /token|key|secret|password|senha|authorization|bearer|api/i
const tokenPrefixes = /(APP_USR-|sk-|sk_live_|sk_test_|ghp_|gho_|github_pat_|glpat-|xoxb-|xoxp-|AIza|ya29\.|pat[A-Za-z0-9]{10,})[A-Za-z0-9._-]{8,}/g
const bearer = /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi
const credentialFlags = /^--?(header|token|api[-_]?key|key|password|secret|auth|authorization)$/i

/** Le o mcp.json do repositorio de agentes, ja normalizado pelo schema. */
export function readServers(agentsDir: string): Record<string, McpServerConfig> {
  const file = join(agentsDir, 'mcp.json')
  if (!existsSync(file)) return {}
  return McpFileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).servers
}

function writeServers(agentsDir: string, servers: Record<string, McpServerConfig>): void {
  writeFileSync(join(agentsDir, 'mcp.json'), `${JSON.stringify({ servers }, null, 2)}\n`)
}

/** Aceita o JSON que os provedores documentam: `{"mcpServers":{...}}`, `{"servers":{...}}` ou um servidor solto. */
export function parseServers(text: string): Record<string, RawServer> {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const inner = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, unknown>
  const out: Record<string, RawServer> = {}
  for (const [name, value] of Object.entries(inner)) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as RawServer
    if (!raw.command && !raw.url) continue
    out[name] = raw
  }
  if (Object.keys(out).length === 0) throw new Error('nenhum servidor MCP reconhecido no JSON')
  return out
}

function varName(server: string, key: string): string {
  return `${server}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** Troca valores sensiveis por referencia a variavel, para o segredo ficar no cofre e nunca no arquivo versionado. */
function maskSecrets(server: string, values: Record<string, string> | undefined, secrets: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values ?? {})) {
    if (typeof value !== 'string') continue
    if (value.startsWith('$')) {
      out[key] = value
      continue
    }
    if (secretHints.test(key) || value.length >= 24) {
      const name = varName(server, key)
      out[key] = `\${${name}}`
      secrets.push(name)
      continue
    }
    out[key] = value
  }
  return out
}

/** Esconde credenciais que vem soltas nos argumentos, como cabecalho de autorizacao ou token com prefixo conhecido. */
function maskArgs(server: string, args: string[], secrets: string[]): string[] {
  const out: string[] = []
  let previousWasFlag = false
  for (const arg of args) {
    if (arg.includes('${')) {
      out.push(arg)
      previousWasFlag = credentialFlags.test(arg)
      continue
    }
    const name = varName(server, 'token')
    let masked = arg.replace(bearer, (m) => `${m.split(/\s+/)[0]} \${${name}}`).replace(tokenPrefixes, `\${${name}}`)
    if (previousWasFlag && masked === arg && arg.length >= 20 && !arg.includes(' ')) masked = `\${${name}}`
    if (masked !== arg) secrets.push(name)
    out.push(masked)
    previousWasFlag = credentialFlags.test(arg)
  }
  return out
}

function toConfig(name: string, raw: RawServer, secrets: string[]): McpServerConfig {
  const base = {
    args: maskArgs(name, raw.args ?? [], secrets),
    env: maskSecrets(name, raw.env, secrets),
    headers: maskSecrets(name, raw.headers, secrets),
    risk: { read_: 'read', list_: 'read', get_: 'read', search_: 'read', '*': 'write' } as Record<string, 'read' | 'write' | 'exec'>,
    enabled: true,
  }
  return raw.url ? { ...base, url: raw.url } : { ...base, command: raw.command! }
}

/** Junta servidores novos ao mcp.json, mantendo os que ja existem com o mesmo nome. */
export function addServers(agentsDir: string, incoming: Record<string, RawServer>): SaveResult {
  const servers = readServers(agentsDir)
  const added: string[] = []
  const secrets: string[] = []
  for (const [name, raw] of Object.entries(incoming)) {
    servers[name] = toConfig(name, raw, secrets)
    added.push(name)
  }
  writeServers(agentsDir, servers)
  return { added, secrets: [...new Set(secrets)] }
}

export function removeServer(agentsDir: string, name: string): boolean {
  const servers = readServers(agentsDir)
  if (!(name in servers)) return false
  delete servers[name]
  writeServers(agentsDir, servers)
  return true
}

export function setEnabled(agentsDir: string, name: string, enabled: boolean): boolean {
  const servers = readServers(agentsDir)
  const server = servers[name]
  if (!server) return false
  servers[name] = { ...server, enabled }
  writeServers(agentsDir, servers)
  return true
}

/** Servidores ja configurados no Claude Code deste usuario, para importar sem digitar nada. */
export function claudeCodeServers(): Record<string, RawServer> {
  const file = join(homedir(), '.claude.json')
  if (!existsSync(file)) return {}
  const data = JSON.parse(readFileSync(file, 'utf8')) as {
    mcpServers?: Record<string, RawServer>
    projects?: Record<string, { mcpServers?: Record<string, RawServer> }>
  }
  const out: Record<string, RawServer> = { ...(data.mcpServers ?? {}) }
  for (const project of Object.values(data.projects ?? {})) {
    for (const [name, raw] of Object.entries(project.mcpServers ?? {})) {
      if (!out[name]) out[name] = raw
    }
  }
  return out
}

/** Agentes que declaram um servidor MCP hoje. */
export function agentsUsing(agentsDir: string, server: string): string[] {
  return profileFiles(agentsDir)
    .filter(({ servers }) => servers.includes(server))
    .map(({ name }) => name)
}

/** Reescreve a linha `mcp: [...]` do perfil, que e a lista de servidores que o agente enxerga. */
export function setAgentServers(agentsDir: string, agent: string, servers: string[]): void {
  const file = join(agentsDir, 'profiles', `${agent}.md`)
  if (!existsSync(file)) throw new Error(`perfil não encontrado: ${agent}`)
  const text = readFileSync(file, 'utf8')
  const linha = /^(\s*)mcp:\s*\[[^\]]*\]\s*$/m
  if (!linha.test(text)) throw new Error(`perfil ${agent} sem a linha mcp: [] em tools`)
  writeFileSync(file, text.replace(linha, (_m, espaco: string) => `${espaco}mcp: [${servers.join(', ')}]`))
}

function profileFiles(agentsDir: string): { name: string; servers: string[] }[] {
  const dir = join(agentsDir, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = readFileSync(join(dir, f), 'utf8')
      const match = /^\s*mcp:\s*\[([^\]]*)\]\s*$/m.exec(text)
      const servers = (match?.[1] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      return { name: f.replace(/\.md$/, ''), servers }
    })
}

/** Servidores MCP declarados por um agente. */
export function profileServers(agentsDir: string, agent: string): string[] {
  return profileFiles(agentsDir).find((p) => p.name === agent)?.servers ?? []
}
