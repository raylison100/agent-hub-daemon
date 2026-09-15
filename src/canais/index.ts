import type { CanalId, EstadoDoCanal } from '@agent-hub/core'
import type { SecretStore } from '../secrets.js'
import type { SessionStore } from '../store.js'
import { PonteDeCanal, type ConfigDoCanal } from './ponte.js'
import { telegram } from './telegram.js'
import type { TipoDeCanal } from './tipos.js'

export const tiposDeCanal: TipoDeCanal[] = [telegram]

export interface DependenciasDosCanais {
  store: SessionStore
  secrets: SecretStore
  daemonUrl: string
  daemonToken: string
  workspacePadrao: string
  log(texto: string): void
  mudou(): void
}

/** Canais de conversa configurados pela interface: guarda campos e credenciais, liga e desliga cada ponte. */
export class Canais {
  private readonly pontes = new Map<CanalId, PonteDeCanal>()
  private readonly erros = new Map<CanalId, string>()

  constructor(private readonly deps: DependenciasDosCanais) {}

  iniciar(): void {
    for (const tipo of tiposDeCanal) if (this.config(tipo.id).ligado) this.ligarPonte(tipo)
  }

  parar(): void {
    for (const ponte of this.pontes.values()) ponte.parar()
    this.pontes.clear()
  }

  estado(): EstadoDoCanal[] {
    return tiposDeCanal.map((tipo) => {
      const c = this.config(tipo.id)
      const valores = this.valores(tipo)
      return {
        id: tipo.id,
        nome: tipo.nome,
        descricao: tipo.descricao,
        passos: tipo.passos,
        campos: tipo.campos.map((campo) => {
          const valor = valores[campo.chave] ?? ''
          return { ...campo, preenchido: valor !== '', dica: campo.segredo ? (valor ? `termina em ${valor.slice(-4)}` : '') : valor }
        }),
        configurado: tipo.campos.every((campo) => !campo.obrigatorio || Boolean(valores[campo.chave])),
        conta: c.conta,
        ligado: c.ligado,
        rodando: this.pontes.has(tipo.id),
        erro: this.erros.get(tipo.id) ?? null,
        permitidos: c.permitidos,
        pedidos: c.pedidos,
      }
    })
  }

  /** Valida no servico e grava os campos; segredo em branco mantem o valor salvo. */
  async salvar(id: CanalId, novos: Record<string, string>): Promise<void> {
    const tipo = this.tipo(id)
    const atuais = this.valores(tipo)
    const valores: Record<string, string> = {}
    for (const campo of tipo.campos) {
      const novo = novos[campo.chave]?.trim()
      valores[campo.chave] = novo || (campo.segredo ? (atuais[campo.chave] ?? '') : '')
      if (campo.obrigatorio && !valores[campo.chave]) throw new Error(`preencha ${campo.rotulo}`)
    }
    const { conta } = await tipo.validar(valores)
    for (const campo of tipo.campos) {
      if (campo.segredo) this.deps.secrets.set(nomeDoSegredo(id, campo.chave), valores[campo.chave]!)
    }
    this.alterar(id, (c) => {
      c.conta = conta
      c.valores = Object.fromEntries(tipo.campos.filter((campo) => !campo.segredo).map((campo) => [campo.chave, valores[campo.chave] ?? '']))
    })
    this.erros.delete(id)
    if (this.config(id).ligado) this.reiniciar(tipo)
    this.deps.mudou()
  }

  ligar(id: CanalId, ligado: boolean): void {
    const tipo = this.tipo(id)
    this.alterar(id, (c) => {
      c.ligado = ligado
    })
    if (ligado) this.reiniciar(tipo)
    else this.desligarPonte(id)
    this.deps.mudou()
  }

  permitir(id: CanalId, pessoa: string): void {
    this.alterar(id, (c) => {
      const pedido = c.pedidos.find((p) => p.id === pessoa)
      if (!c.permitidos.some((p) => p.id === pessoa)) c.permitidos.push(pedido ? { id: pedido.id, nome: pedido.nome, usuario: pedido.usuario, conversa: pedido.conversa } : { id: pessoa })
      c.pedidos = c.pedidos.filter((p) => p.id !== pessoa)
    })
    this.deps.mudou()
  }

  removerPessoa(id: CanalId, pessoa: string): void {
    this.alterar(id, (c) => {
      c.permitidos = c.permitidos.filter((p) => p.id !== pessoa)
      c.pedidos = c.pedidos.filter((p) => p.id !== pessoa)
    })
    this.deps.mudou()
  }

  async testar(id: CanalId): Promise<string> {
    const ponte = this.pontes.get(id)
    if (!ponte) throw new Error('ligue o canal antes de testar')
    const conversas = this.config(id).permitidos.map((p) => p.conversa).filter((c): c is string => Boolean(c))
    if (conversas.length === 0) throw new Error('nenhuma pessoa permitida falou com o bot ainda; mande uma mensagem para ele primeiro')
    for (const conversa of conversas) await ponte.enviar(conversa, 'Agent Hub conectado. As respostas e os avisos dos agentes chegam aqui.')
    return `mensagem enviada para ${conversas.length} conversa(s)`
  }

  apagar(id: CanalId): void {
    const tipo = this.tipo(id)
    this.desligarPonte(id)
    for (const campo of tipo.campos) if (campo.segredo) this.deps.secrets.delete(nomeDoSegredo(id, campo.chave))
    this.deps.store.setSetting(chave(id), JSON.stringify(configVazia()))
    this.erros.delete(id)
    this.deps.mudou()
  }

  private reiniciar(tipo: TipoDeCanal): void {
    this.desligarPonte(tipo.id)
    this.ligarPonte(tipo)
  }

  private ligarPonte(tipo: TipoDeCanal): void {
    const valores = this.valores(tipo)
    if (tipo.campos.some((campo) => campo.obrigatorio && !valores[campo.chave])) {
      this.erros.set(tipo.id, 'canal ligado sem configuracao completa')
      return
    }
    try {
      const ponte = new PonteDeCanal(tipo, tipo.criar(valores), {
        daemonUrl: this.deps.daemonUrl,
        daemonToken: this.deps.daemonToken,
        workspacePadrao: this.deps.workspacePadrao,
        config: () => this.config(tipo.id),
        alterar: (mudanca) => {
          this.alterar(tipo.id, mudanca)
          this.deps.mudou()
        },
        log: (texto) => this.deps.log(`[canal ${tipo.id}] ${texto}`),
      })
      ponte.iniciar()
      this.pontes.set(tipo.id, ponte)
      this.erros.delete(tipo.id)
    } catch (err) {
      this.erros.set(tipo.id, err instanceof Error ? err.message : String(err))
    }
  }

  private desligarPonte(id: CanalId): void {
    this.pontes.get(id)?.parar()
    this.pontes.delete(id)
  }

  private tipo(id: CanalId): TipoDeCanal {
    const tipo = tiposDeCanal.find((t) => t.id === id)
    if (!tipo) throw new Error(`canal ainda nao suportado: ${id}`)
    return tipo
  }

  private valores(tipo: TipoDeCanal): Record<string, string> {
    const c = this.config(tipo.id)
    const out: Record<string, string> = { ...c.valores }
    for (const campo of tipo.campos) {
      if (campo.segredo) out[campo.chave] = this.deps.secrets.get(nomeDoSegredo(tipo.id, campo.chave)) ?? ''
    }
    return out
  }

  private config(id: CanalId): ConfigDoCanal {
    const bruto = this.deps.store.setting(chave(id))
    return bruto ? { ...configVazia(), ...(JSON.parse(bruto) as Partial<ConfigDoCanal>) } : configVazia()
  }

  private alterar(id: CanalId, mudanca: (c: ConfigDoCanal) => void): void {
    const c = this.config(id)
    mudanca(c)
    this.deps.store.setSetting(chave(id), JSON.stringify(c))
  }
}

function chave(id: CanalId): string {
  return `canal.${id}`
}

function nomeDoSegredo(id: CanalId, campo: string): string {
  return `CANAL_${id}_${campo}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

function configVazia(): ConfigDoCanal {
  return { ligado: false, conta: null, valores: {}, permitidos: [], pedidos: [], conversas: {} }
}
