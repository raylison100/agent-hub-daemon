import {
  authorizationUrl,
  discover,
  exchange,
  expired,
  pkce,
  registerClient,
  type McpServerConfig,
  type OAuthConfig,
  type OAuthTokens,
} from '@agent-hub/core'
import { randomBytes } from 'node:crypto'
import type { Runtime } from './runtime.js'

interface Pendente {
  server: string
  verifier: string
  cfg: OAuthConfig
  criadoEm: number
}

const tokenKey = (server: string) => `MCP_OAUTH_${server.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/** Autorizacao OAuth dos servidores MCP remotos: descoberta, PKCE, troca e renovacao, com os tokens no cofre cifrado. */
export class McpOAuth {
  private readonly pendentes = new Map<string, Pendente>()

  constructor(private readonly runtime: Runtime) {}

  /** Monta o link que o usuario abre no navegador para autorizar o servidor. */
  async start(server: string, redirectUri: string): Promise<string> {
    const config = this.config(server)
    const cfg = await this.resolveConfig(config, redirectUri)
    const { verifier, challenge } = pkce()
    const state = randomBytes(16).toString('hex')
    this.pendentes.set(state, { server, verifier, cfg, criadoEm: Date.now() })
    return authorizationUrl(cfg, redirectUri, state, challenge)
  }

  /** Fecha o ciclo: troca o codigo pelo token e guarda no cofre. */
  async finish(state: string, code: string, redirectUri: string): Promise<string> {
    const pendente = this.pendentes.get(state)
    if (!pendente) throw new Error('autorização desconhecida ou já usada')
    this.pendentes.delete(state)
    const tokens = await exchange(pendente.cfg, { code, verifier: pendente.verifier, redirectUri })
    this.guardar(pendente.server, tokens)
    return pendente.server
  }

  /** Token valido do servidor, renovando quando esta vencendo. Sem OAuth configurado, devolve undefined. */
  async bearer(server: string): Promise<string | undefined> {
    const config = this.runtime.repo.mcp.servers[server]
    if (!config?.oauth) return undefined
    const guardado = this.ler(server)
    if (!guardado) return undefined
    if (!expired(guardado)) return guardado.accessToken
    if (!guardado.refreshToken) return undefined
    const cfg = await this.resolveConfig(config, '')
    const novos = await exchange(cfg, { refreshToken: guardado.refreshToken })
    this.guardar(server, { refreshToken: guardado.refreshToken, ...novos })
    return novos.accessToken
  }

  autorizado(server: string): boolean {
    return this.ler(server) !== null
  }

  esquecer(server: string): void {
    this.runtime.secrets.delete(tokenKey(server))
  }

  private config(server: string): McpServerConfig {
    const config = this.runtime.repo.mcp.servers[server]
    if (!config) throw new Error(`servidor MCP não configurado: ${server}`)
    if (!config.url) throw new Error('OAuth só vale para servidor MCP por HTTP')
    if (!config.oauth) throw new Error(`servidor ${server} não declara o bloco oauth em mcp.json`)
    return config
  }

  /** Completa o que falta no bloco oauth: descobre os endpoints pelo issuer e registra o cliente quando o servidor permite. */
  private async resolveConfig(config: McpServerConfig, redirectUri: string): Promise<OAuthConfig> {
    const bruto = config.oauth!
    let cfg: OAuthConfig = { ...bruto }
    if ((!cfg.authorization_url || !cfg.token_url) && bruto.issuer) cfg = { ...(await discover(bruto.issuer)), ...cfg }
    if (!cfg.client_id && cfg.register_url && redirectUri) {
      const registrado = await registerClient(cfg.register_url, redirectUri)
      cfg = { ...cfg, ...registrado }
    }
    if (!cfg.authorization_url || !cfg.token_url) throw new Error('faltam authorization_url e token_url, e não deu para descobrir pelo issuer')
    return cfg
  }

  private guardar(server: string, tokens: OAuthTokens): void {
    this.runtime.secrets.set(tokenKey(server), JSON.stringify(tokens))
  }

  private ler(server: string): OAuthTokens | null {
    const bruto = process.env[tokenKey(server)]
    if (!bruto) return null
    try {
      return JSON.parse(bruto) as OAuthTokens
    } catch {
      return null
    }
  }
}
