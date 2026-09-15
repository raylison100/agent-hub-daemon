import type { CanalId, EstadoDoCanal, TipoDeCanalResumo } from '@agent-hub/core'
import type { SecretStore } from '../secrets.js'
import type { SessionStore } from '../store.js'
import { PonteDeCanal, type ConfigDoCanal, type PadraoDoCanal } from './ponte.js'
import { telegram } from './telegram.js'
import type { TipoDeCanal } from './tipos.js'
import { whatsapp } from './whatsapp.js'

export const tiposDeCanal: TipoDeCanal[] = [telegram, whatsapp]

const planejados: TipoDeCanalResumo[] = [
  { id: 'slack', nome: 'Slack', descricao: 'Bot no workspace do Slack, por Socket Mode, sem endereco publico.', disponivel: false },
  { id: 'discord', nome: 'Discord', descricao: 'Bot num servidor do Discord, por mensagem direta ou canal.', disponivel: false },
]

const chaveDaLista = 'canais'

export interface DependenciasDosCanais {
  store: SessionStore
  secrets: SecretStore
  daemonUrl: string
  daemonToken: string
  workspacePadrao: string
  log(texto: string): void
  mudou(): void
}

/** Canais de conversa criados pela interface, varios por tipo: guarda campos e credenciais e liga e desliga cada ponte. */
export class Canais {
  private readonly pontes = new Map<string, PonteDeCanal>()
  private readonly erros = new Map<string, string>()
  private readonly fotosTentadas = new Set<string>()

  constructor(private readonly deps: DependenciasDosCanais) {
    this.migrarCanalUnico()
  }

  iniciar(): void {
    for (const c of this.lista()) if (c.ligado) this.ligarPonte(c.id)
  }

  parar(): void {
    for (const ponte of this.pontes.values()) ponte.parar()
    this.pontes.clear()
  }

  tipos(): TipoDeCanalResumo[] {
    return [...tiposDeCanal.map((t) => ({ id: t.id, nome: t.nome, descricao: t.descricao, disponivel: true })), ...planejados]
  }

  estado(): EstadoDoCanal[] {
    return this.lista().map((c) => {
      const tipo = this.tipo(c.tipo)
      const valores = this.valores(c)
      this.buscarFotos(c, tipo, valores)
      return {
        id: c.id,
        tipo: c.tipo,
        nome: c.nome,
        descricao: tipo.descricao,
        passos: tipo.passos,
        campos: tipo.campos.map((campo) => {
          const valor = valores[campo.chave] ?? ''
          return { ...campo, preenchido: valor !== '', dica: campo.segredo ? (valor ? `termina em ${valor.slice(-4)}` : '') : valor }
        }),
        configurado: tipo.campos.every((campo) => !campo.obrigatorio || Boolean(valores[campo.chave])),
        conta: c.conta,
        link: c.conta ? tipo.link(c.conta) : null,
        rotuloDoId: tipo.rotuloDoId,
        ligado: c.ligado,
        rodando: this.pontes.has(c.id),
        erro: this.erros.get(c.id) ?? null,
        padrao: c.padrao,
        permitidos: c.permitidos,
        pedidos: c.pedidos,
      }
    })
  }

  criar(tipoId: CanalId, nome: string): string {
    this.tipo(tipoId)
    const limpo = nome.trim()
    if (!limpo) throw new Error('de um nome ao canal')
    const base = slug(limpo) || tipoId
    const ids = new Set(this.lista().map((c) => c.id))
    let id = base
    for (let i = 2; ids.has(id); i++) id = `${base}-${i}`
    this.gravar([...this.lista(), { ...configVazia(id, tipoId), nome: limpo }])
    return id
  }

  /** Valida no servico e grava os campos; segredo em branco mantem o valor salvo. */
  async salvar(id: string, novos: Record<string, string>): Promise<void> {
    const c = this.config(id)
    const tipo = this.tipo(c.tipo)
    const atuais = this.valores(c)
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
    this.alterar(id, (atual) => {
      atual.conta = conta
      atual.valores = Object.fromEntries(tipo.campos.filter((campo) => !campo.segredo).map((campo) => [campo.chave, valores[campo.chave] ?? '']))
    })
    this.erros.delete(id)
    if (this.config(id).ligado) this.reiniciar(id)
  }

  definirPadrao(id: string, dados: { nome?: string } & PadraoDoCanal): void {
    this.alterar(id, (c) => {
      if (dados.nome?.trim()) c.nome = dados.nome.trim()
      c.padrao = {
        agente: dados.agente?.trim() || undefined,
        papel: dados.papel?.trim() || undefined,
        workspace: dados.workspace?.trim() || undefined,
      }
      c.conversas = Object.fromEntries(Object.entries(c.conversas).map(([k, v]) => [k, { ...v, sessionId: undefined }]))
    })
  }

  ligar(id: string, ligado: boolean): void {
    this.alterar(id, (c) => {
      c.ligado = ligado
    })
    if (ligado) this.reiniciar(id)
    else this.desligarPonte(id)
  }

  permitir(id: string, pessoa: string): void {
    this.alterar(id, (c) => {
      const pedido = c.pedidos.find((p) => p.id === pessoa)
      if (!c.permitidos.some((p) => p.id === pessoa)) c.permitidos.push(pedido ? { id: pedido.id, nome: pedido.nome, apelido: pedido.apelido, usuario: pedido.usuario, conversa: pedido.conversa, foto: pedido.foto } : { id: pessoa })
      c.pedidos = c.pedidos.filter((p) => p.id !== pessoa)
    })
  }

  apelidar(id: string, pessoa: string, apelido: string): void {
    this.alterar(id, (c) => {
      for (const p of [...c.permitidos, ...c.pedidos]) if (p.id === pessoa) p.apelido = apelido.trim() || undefined
    })
  }

  removerPessoa(id: string, pessoa: string): void {
    this.alterar(id, (c) => {
      c.permitidos = c.permitidos.filter((p) => p.id !== pessoa)
      c.pedidos = c.pedidos.filter((p) => p.id !== pessoa)
    })
  }

  async testar(id: string): Promise<string> {
    const ponte = this.pontes.get(id)
    if (!ponte) throw new Error('ligue o canal antes de testar')
    const conversas = this.config(id).permitidos.map((p) => p.conversa).filter((c): c is string => Boolean(c))
    if (conversas.length === 0) throw new Error('ninguem permitido ainda: abra o bot, mande uma mensagem e clique em Permitir em "Pediram acesso"')
    for (const conversa of conversas) await ponte.enviar(conversa, 'Agent Hub conectado. As respostas e os avisos dos agentes chegam aqui.')
    return `mensagem enviada para ${conversas.length} conversa(s)`
  }

  apagar(id: string): void {
    const c = this.config(id)
    this.desligarPonte(id)
    for (const campo of this.tipo(c.tipo).campos) if (campo.segredo) this.deps.secrets.delete(nomeDoSegredo(id, campo.chave))
    this.gravar(this.lista().filter((x) => x.id !== id))
    this.erros.delete(id)
  }

  /** Baixa uma vez por execucao a foto de perfil de quem ainda nao tem, grava na midia e avisa as telas. */
  private buscarFotos(c: ConfigDoCanal, tipo: TipoDeCanal, valores: Record<string, string>): void {
    if (!tipo.foto) return
    for (const p of [...c.permitidos, ...c.pedidos]) {
      const chave = `${c.id}:${p.id}`
      if (p.foto || this.fotosTentadas.has(chave)) continue
      this.fotosTentadas.add(chave)
      void tipo
        .foto(valores, p.id)
        .then((foto) => {
          if (!foto) return
          const ref = this.deps.store.putMedia(foto.mediaType, foto.base64)
          this.alterar(c.id, (atual) => {
            for (const pessoa of [...atual.permitidos, ...atual.pedidos]) if (pessoa.id === p.id) pessoa.foto = ref
          })
          this.deps.mudou()
        })
        .catch((err: unknown) => this.deps.log(`[canal ${c.id}] foto de ${p.id}: ${err instanceof Error ? err.message : String(err)}`))
    }
  }

  private reiniciar(id: string): void {
    this.desligarPonte(id)
    this.ligarPonte(id)
  }

  private ligarPonte(id: string): void {
    const c = this.config(id)
    const tipo = this.tipo(c.tipo)
    const valores = this.valores(c)
    if (tipo.campos.some((campo) => campo.obrigatorio && !valores[campo.chave])) {
      this.erros.set(id, 'canal ligado sem configuracao completa')
      return
    }
    try {
      const ponte = new PonteDeCanal(tipo, tipo.criar(valores), {
        daemonUrl: this.deps.daemonUrl,
        daemonToken: this.deps.daemonToken,
        workspacePadrao: this.deps.workspacePadrao,
        config: () => this.config(id),
        alterar: (mudanca) => {
          this.alterar(id, mudanca)
          this.deps.mudou()
        },
        log: (texto) => this.deps.log(`[canal ${id}] ${texto}`),
      })
      ponte.iniciar()
      this.pontes.set(id, ponte)
      this.erros.delete(id)
    } catch (err) {
      this.erros.set(id, err instanceof Error ? err.message : String(err))
    }
  }

  private desligarPonte(id: string): void {
    this.pontes.get(id)?.parar()
    this.pontes.delete(id)
  }

  private tipo(id: CanalId): TipoDeCanal {
    const tipo = tiposDeCanal.find((t) => t.id === id)
    if (!tipo) throw new Error(`tipo de canal ainda nao suportado: ${id}`)
    return tipo
  }

  private valores(c: ConfigDoCanal): Record<string, string> {
    const out: Record<string, string> = { ...c.valores }
    for (const campo of this.tipo(c.tipo).campos) {
      if (campo.segredo) out[campo.chave] = this.deps.secrets.get(nomeDoSegredo(c.id, campo.chave)) ?? ''
    }
    return out
  }

  private lista(): ConfigDoCanal[] {
    const bruto = this.deps.store.setting(chaveDaLista)
    if (!bruto) return []
    return (JSON.parse(bruto) as ConfigDoCanal[]).map((c) => ({ ...configVazia(c.id, c.tipo), ...c }))
  }

  private gravar(lista: ConfigDoCanal[]): void {
    this.deps.store.setSetting(chaveDaLista, JSON.stringify(lista))
  }

  private config(id: string): ConfigDoCanal {
    const c = this.lista().find((x) => x.id === id)
    if (!c) throw new Error(`canal nao encontrado: ${id}`)
    return c
  }

  private alterar(id: string, mudanca: (c: ConfigDoCanal) => void): void {
    const lista = this.lista()
    const c = lista.find((x) => x.id === id)
    if (!c) throw new Error(`canal nao encontrado: ${id}`)
    mudanca(c)
    this.gravar(lista)
  }

  private migrarCanalUnico(): void {
    if (this.deps.store.setting(chaveDaLista)) return
    const antigo = this.deps.store.setting('canal.telegram')
    if (!antigo) return
    const c = JSON.parse(antigo) as Partial<ConfigDoCanal>
    this.gravar([{ ...configVazia('telegram', 'telegram'), ...c, id: 'telegram', tipo: 'telegram', nome: c.conta ?? 'Telegram' }])
  }
}

function nomeDoSegredo(id: string, campo: string): string {
  return `CANAL_${id}_${campo}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

function slug(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function configVazia(id: string, tipo: CanalId): ConfigDoCanal {
  return { id, tipo, nome: id, padrao: {}, ligado: false, conta: null, valores: {}, permitidos: [], pedidos: [], conversas: {} }
}
