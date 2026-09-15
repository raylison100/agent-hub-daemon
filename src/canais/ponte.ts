import { NodeDaemonClient, type ServerFrame } from '@agent-hub/core'
import { separarImagens } from './imagens.js'
import type { BotaoRecebido, MensagemRecebida, Pessoa, TipoDeCanal, Transporte } from './tipos.js'

export interface PessoaPermitida extends Pessoa {
  apelido?: string
  conversa?: string
  foto?: string
}

export interface PedidoDeAcesso extends Pessoa {
  apelido?: string
  foto?: string
  conversa: string
  em: number
}

export interface ConversaDoCanal {
  sessionId?: string
  workspace?: string
  agent?: string
}

export interface PadraoDoCanal {
  agente?: string
  papel?: string
  workspace?: string
}

export interface ConfigDoCanal {
  id: string
  tipo: TipoDeCanal['id']
  nome: string
  padrao: PadraoDoCanal
  ligado: boolean
  conta: string | null
  valores: Record<string, string>
  permitidos: PessoaPermitida[]
  pedidos: PedidoDeAcesso[]
  conversas: Record<string, ConversaDoCanal>
  mensagens?: Record<string, string>
}

export interface DependenciasDaPonte {
  daemonUrl: string
  daemonToken: string
  workspacePadrao: string
  config(): ConfigDoCanal
  alterar(mudanca: (c: ConfigDoCanal) => void): void
  log(texto: string): void
}

interface RunEmCurso {
  conversa: string
  sessionId: string
  texto: string[]
  ferramentas: number
}

const ajuda = [
  'Comandos:',
  '/workspace <dir>  define o diretorio da proxima sessao',
  '/agente <nome>    fixa o agente da proxima sessao (vazio = roteamento)',
  '/nova             comeca uma sessao nova na proxima mensagem',
  '/sessoes          ultimas sessoes',
  '/custo            custo de hoje por agente',
  '/cancelar         cancela o run atual',
  '/aprovar <codigo> e /negar <codigo>  respondem a um pedido de aprovacao',
  '/status           conexao com o daemon',
].join('\n')

/** Liga um canal de conversa ao daemon: sessoes por conversa, comandos, aprovacoes e respostas das automacoes. */
export class PonteDeCanal {
  private readonly daemon: NodeDaemonClient
  private readonly runs = new Map<string, RunEmCurso>()
  private readonly conversaDaSessao = new Map<string, string>()
  private readonly aprovacoes = new Map<string, string>()
  private desligar: (() => void) | null = null

  constructor(
    private readonly tipo: TipoDeCanal,
    private readonly transporte: Transporte,
    private readonly deps: DependenciasDaPonte,
  ) {
    this.daemon = new NodeDaemonClient({ url: deps.daemonUrl, token: deps.daemonToken, client: `canal-${deps.config().id}`, log: (m) => deps.log(m) })
  }

  iniciar(): void {
    this.desligar = this.daemon.on((f) => this.aoReceberQuadro(f))
    this.daemon.start()
    this.transporte.iniciar({
      mensagem: (m) => void this.aoReceberMensagem(m).catch((err: unknown) => this.deps.log(descrever(err))),
      botao: (b) => void this.aoReceberBotao(b).catch((err: unknown) => this.deps.log(descrever(err))),
      log: (t) => this.deps.log(t),
    })
  }

  parar(): void {
    this.transporte.parar()
    this.desligar?.()
    this.daemon.stop()
  }

  /** Conversa que recebe avisos: a da primeira pessoa permitida que ja falou com o bot. */
  conversaPadrao(): string | undefined {
    return this.deps.config().permitidos.find((p) => p.conversa)?.conversa
  }

  async enviar(conversa: string, texto: string): Promise<void> {
    await this.transporte.enviar(conversa, texto)
  }

  /** Envia a resposta de um agente: o texto primeiro e depois as imagens citadas em markdown, quando o canal aceita imagem. */
  private async responder(conversa: string, texto: string, workspace: string, sessionId: string): Promise<void> {
    const ids: string[] = []
    if (!this.transporte.enviarImagem) {
      ids.push(...(await this.transporte.enviar(conversa, texto)))
    } else {
      const separado = separarImagens(texto, workspace)
      ids.push(...(await this.transporte.enviar(conversa, separado.texto || '(imagens abaixo)')))
      for (const imagem of separado.imagens) {
        try {
          ids.push(...(await this.transporte.enviarImagem(conversa, imagem)))
        } catch (err) {
          await this.transporte.enviar(conversa, `Nao consegui enviar ${imagem.nome}: ${descrever(err)}`)
        }
      }
    }
    this.lembrarMensagens(ids, sessionId)
  }

  /** Guarda de qual sessao veio cada mensagem enviada, para a resposta citando uma delas voltar para a mesma sessao. */
  private lembrarMensagens(ids: string[], sessionId: string): void {
    if (ids.length === 0) return
    this.deps.alterar((c) => {
      const mapa = { ...(c.mensagens ?? {}) }
      for (const id of ids) mapa[id] = sessionId
      const chaves = Object.keys(mapa)
      c.mensagens = Object.fromEntries(chaves.slice(Math.max(0, chaves.length - 500)).map((k) => [k, mapa[k]!]))
    })
  }

  private workspaceDa(conversa: string): string {
    const config = this.deps.config()
    return config.conversas[conversa]?.workspace ?? config.padrao.workspace ?? this.deps.workspacePadrao
  }

  private permitido(id: string): PessoaPermitida | undefined {
    return this.deps.config().permitidos.find((p) => p.id === id)
  }

  private async aoReceberMensagem(m: MensagemRecebida): Promise<void> {
    const pessoa = this.permitido(m.remetente.id)
    if (!pessoa) {
      await this.registrarPedido(m)
      return
    }
    if (pessoa.conversa !== m.conversa || pessoa.nome !== (m.remetente.nome ?? pessoa.nome)) {
      this.deps.alterar((c) => {
        const alvo = c.permitidos.find((p) => p.id === m.remetente.id)
        if (alvo) Object.assign(alvo, { conversa: m.conversa, nome: m.remetente.nome ?? alvo.nome, usuario: m.remetente.usuario ?? alvo.usuario })
      })
    }
    const texto = m.texto.trim()
    if (texto.startsWith('/')) {
      await this.comando(m.conversa, texto)
      return
    }
    if (!this.daemon.online) {
      await this.transporte.enviar(m.conversa, 'Daemon desconectado. Tente de novo em instantes.')
      return
    }
    const config = this.deps.config()
    const estado = config.conversas[m.conversa] ?? {}
    const citada = m.respondendoA ? config.mensagens?.[m.respondendoA] : undefined
    if (citada && citada !== estado.sessionId) this.salvarConversa(m.conversa, { ...estado, sessionId: citada })
    let sessionId = citada ?? estado.sessionId
    if (!sessionId) {
      const criada = await this.daemon.request(
        {
          type: 'session.create',
          workspace: estado.workspace ?? config.padrao.workspace ?? this.deps.workspacePadrao,
          agent: estado.agent ?? config.padrao.agente,
          role: config.padrao.papel,
          text: texto,
        },
        'session.created',
      )
      sessionId = criada.session.id
      this.salvarConversa(m.conversa, { ...estado, sessionId })
      await this.transporte.enviar(m.conversa, `Sessao nova com ${criada.session.agent}${criada.routed ? ` (roteado por ${criada.routed.intent ?? 'regra'})` : ''}.`)
    }
    this.conversaDaSessao.set(sessionId, m.conversa)
    const iniciado = await this.daemon.request({ type: 'run.start', session_id: sessionId, text: texto }, 'run.started')
    this.runs.set(iniciado.run_id, { conversa: m.conversa, sessionId, texto: [], ferramentas: 0 })
  }

  private async registrarPedido(m: MensagemRecebida): Promise<void> {
    const jaPediu = this.deps.config().pedidos.some((p) => p.id === m.remetente.id)
    this.deps.alterar((c) => {
      c.pedidos = [{ ...m.remetente, conversa: m.conversa, em: Date.now() }, ...c.pedidos.filter((p) => p.id !== m.remetente.id)].slice(0, 20)
    })
    if (jaPediu) return
    const quem = m.remetente.nome ?? m.remetente.usuario ?? m.remetente.id
    await this.transporte.enviar(m.conversa, `Este bot e privado. Pedido de acesso registrado para ${quem} (id ${m.remetente.id}). Quem administra o Agent Hub libera em Configuracoes > Canais.`)
  }

  private async comando(conversa: string, texto: string): Promise<void> {
    const [cmd, ...resto] = texto.split(/\s+/)
    const arg = resto.join(' ').trim()
    const estado = this.deps.config().conversas[conversa] ?? {}
    switch (cmd) {
      case '/start':
      case '/ajuda':
        await this.transporte.enviar(conversa, ajuda)
        return
      case '/workspace':
        this.salvarConversa(conversa, { ...estado, workspace: arg || undefined, sessionId: undefined })
        await this.transporte.enviar(conversa, arg ? `Workspace: ${arg}` : `Workspace padrao: ${this.deps.config().padrao.workspace ?? this.deps.workspacePadrao}`)
        return
      case '/agente':
        this.salvarConversa(conversa, { ...estado, agent: arg || undefined, sessionId: undefined })
        await this.transporte.enviar(conversa, arg ? `Agente: ${arg}` : 'Agente por roteamento.')
        return
      case '/nova':
        this.salvarConversa(conversa, { ...estado, sessionId: undefined })
        await this.transporte.enviar(conversa, 'A proxima mensagem abre uma sessao nova.')
        return
      case '/sessoes': {
        const res = await this.daemon.request({ type: 'session.list', limit: 5 }, 'session.list')
        await this.transporte.enviar(conversa, res.sessions.map((s) => `${s.title} (${s.agent}, ${s.costUsd.toFixed(4)} USD)`).join('\n') || 'Nenhuma sessao.')
        return
      }
      case '/custo': {
        const inicio = new Date()
        inicio.setHours(0, 0, 0, 0)
        const res = await this.daemon.request({ type: 'cost.report', group: 'agent', since: inicio.getTime() }, 'cost.report')
        const total = res.rows.reduce((a, r) => a + r.costUsd, 0)
        await this.transporte.enviar(conversa, [...res.rows.map((r) => `${r.key}: ${r.costUsd.toFixed(4)} USD em ${r.calls} chamadas`), `total: ${total.toFixed(4)} USD`].join('\n'))
        return
      }
      case '/cancelar': {
        const runId = [...this.runs.entries()].find(([, r]) => r.conversa === conversa)?.[0]
        if (runId) this.daemon.send({ type: 'run.cancel', run_id: runId })
        await this.transporte.enviar(conversa, runId ? 'Cancelamento pedido.' : 'Nenhum run em andamento.')
        return
      }
      case '/aprovar':
      case '/negar': {
        const id = this.aprovacoes.get(arg.toLowerCase())
        if (!id) {
          await this.transporte.enviar(conversa, 'Codigo de aprovacao desconhecido ou expirado.')
          return
        }
        this.daemon.send({ type: 'approval.respond', approval_id: id, decision: cmd === '/aprovar' ? 'allow' : 'deny' })
        this.aprovacoes.delete(arg.toLowerCase())
        await this.transporte.enviar(conversa, cmd === '/aprovar' ? 'Aprovado.' : 'Negado.')
        return
      }
      case '/status':
        await this.transporte.enviar(conversa, this.daemon.online ? 'Daemon conectado.' : 'Daemon desconectado.')
        return
      default:
        await this.transporte.enviar(conversa, 'Comando desconhecido. /ajuda lista os comandos.')
    }
  }

  private async aoReceberBotao(b: BotaoRecebido): Promise<void> {
    if (!this.permitido(b.remetente.id)) return
    const [tipo, id, decisao] = b.dados.split(':')
    if (tipo !== 'apr' || !id || (decisao !== 'allow' && decisao !== 'deny')) return
    try {
      this.daemon.send({ type: 'approval.respond', approval_id: id, decision: decisao })
      await b.confirmar(decisao === 'allow' ? 'Aprovado' : 'Negado')
    } catch (err) {
      await b.confirmar(descrever(err))
    }
  }

  private aoReceberQuadro(f: ServerFrame): void {
    if (f.type === 'event') {
      const run = this.runs.get(f.run_id)
      if (!run) return
      const e = f.event
      if (e.type === 'text_delta') run.texto.push(e.delta)
      if (e.type === 'tool_call') run.ferramentas += 1
      if (e.type === 'run_finished') {
        this.runs.delete(f.run_id)
        const corpo = run.texto.join('').trim() || '(sem texto)'
        const rodape = `\n\n[${e.stop}, ${e.steps} passos, ${run.ferramentas} ferramentas, ${e.costUsd.toFixed(4)} USD]${e.error ? `\n${e.error}` : ''}`
        void this.responder(run.conversa, corpo + rodape, this.workspaceDa(run.conversa), run.sessionId).catch((err: unknown) => this.deps.log(descrever(err)))
      }
      return
    }
    if (f.type === 'approval.required') {
      const conversa = this.conversaDaSessao.get(f.session_id) ?? this.conversaPadrao()
      if (!conversa) return
      const codigo = f.approval_id.slice(0, 6).toLowerCase()
      this.aprovacoes.set(codigo, f.approval_id)
      const pergunta = `Aprovar ${f.tool} (${f.risk})?\n${JSON.stringify(f.args).slice(0, 1500)}`
      const envio = this.tipo.botoes
        ? this.transporte.enviar(conversa, pergunta, [[{ texto: 'Aprovar', dados: `apr:${f.approval_id}:allow` }, { texto: 'Negar', dados: `apr:${f.approval_id}:deny` }]])
        : this.transporte.enviar(conversa, `${pergunta}\n\nResponda /aprovar ${codigo} ou /negar ${codigo}`)
      void envio.catch((err: unknown) => this.deps.log(descrever(err)))
      return
    }
    if (f.type === 'automation.finished' && f.notify?.some((n) => n === this.deps.config().id)) {
      if (f.stop === 'end' && f.text?.trimStart().startsWith('[sem-aviso]')) return
      const conversa = this.conversaPadrao()
      if (!conversa) {
        this.deps.log(`automacao ${f.id} terminou, mas nenhuma pessoa permitida falou com o bot ainda`)
        return
      }
      const status = `Automacao ${f.id} terminou com ${f.stop} (${f.cost_usd.toFixed(4)} USD).`
      if (f.text) {
        const estado = this.deps.config().conversas[conversa] ?? {}
        this.salvarConversa(conversa, { ...estado, sessionId: f.session_id, workspace: f.workspace ?? estado.workspace })
        this.conversaDaSessao.set(f.session_id, conversa)
      }
      const corpo = f.text ? `${f.text}\n\n[${status} Responda aqui para continuar essa sessao; /nova volta ao normal.]` : status
      void this.responder(conversa, corpo, f.workspace ?? this.workspaceDa(conversa), f.session_id).catch((err: unknown) => this.deps.log(descrever(err)))
    }
  }

  private salvarConversa(conversa: string, estado: ConversaDoCanal): void {
    this.deps.alterar((c) => {
      c.conversas[conversa] = estado
    })
  }
}

function descrever(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
