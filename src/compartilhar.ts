import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import WebSocket from 'ws'
import { z } from 'zod'
import {
  deriveE2eKey,
  isSealed,
  openFrame,
  parseProfile,
  relayHeaders,
  sealFrame,
  type AgentProfile,
  type ConvidadoResumo,
  type RecebidoResumo,
  type RelayToClient,
  type RelayToDaemon,
  type SealedFrame,
} from '@agent-hub/core'
import type { SecretStore } from './secrets.js'

const prefixoDoConvite = 'agenthub-convite-1.'
const tetoDeSaida = 8192
const backoffMs = [2000, 5000, 10000, 30000]

export const ConviteSchema = z.object({
  v: z.literal(1),
  relay: z.string().url(),
  sala: z.string().min(32),
  dispositivo: z.string().min(8),
  anfitriao: z.string().min(1),
  modelos: z.array(z.object({ nome: z.string().min(1), janela: z.number().int().positive() })).min(1),
  limite_tokens_dia: z.number().int().positive(),
})

export type Convite = z.infer<typeof ConviteSchema>

type ParaAnfitriao =
  | { type: 'inferencia.pedido'; id: string; metodo: 'GET' | 'POST'; caminho: string; corpo?: string }
  | { type: 'inferencia.cancelar'; id: string }

type ParaConvidado =
  | { type: 'inferencia.resposta'; id: string; status: number; tipo: string }
  | { type: 'inferencia.pedaco'; id: string; dados: string }
  | { type: 'inferencia.fim'; id: string }

export function codificarConvite(convite: Convite): string {
  return prefixoDoConvite + Buffer.from(JSON.stringify(convite)).toString('base64url')
}

export function lerConvite(texto: string): Convite {
  const limpo = texto.trim()
  if (!limpo.startsWith(prefixoDoConvite)) throw new Error(`convite invalido: ele comeca com ${prefixoDoConvite}`)
  let dados: unknown
  try {
    dados = JSON.parse(Buffer.from(limpo.slice(prefixoDoConvite.length), 'base64url').toString('utf8'))
  } catch {
    throw new Error('convite corrompido: copie de novo o texto inteiro')
  }
  return ConviteSchema.parse(dados)
}

/** Tabelas do compartilhamento: convites emitidos, uso por convidado e convites recebidos. Tokens de sala ficam cifrados. */
export function migrarCompartilhamento(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS convidados (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      sala TEXT NOT NULL,
      dispositivo TEXT NOT NULL,
      modelos_json TEXT NOT NULL,
      janela INTEGER NOT NULL,
      limite_tokens_dia INTEGER NOT NULL,
      criado_em INTEGER NOT NULL,
      revogado_em INTEGER
    );
    CREATE TABLE IF NOT EXISTS uso_compartilhado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      convidado_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      modelo TEXT NOT NULL,
      entrada INTEGER NOT NULL,
      saida INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      status INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS uso_compartilhado_convidado ON uso_compartilhado(convidado_id, ts);
    CREATE TABLE IF NOT EXISTS recebidos (
      id TEXT PRIMARY KEY,
      anfitriao TEXT NOT NULL,
      relay TEXT NOT NULL,
      sala TEXT NOT NULL,
      dispositivo TEXT NOT NULL,
      modelos_json TEXT NOT NULL,
      limite_tokens_dia INTEGER NOT NULL,
      no_roteamento INTEGER NOT NULL,
      criado_em INTEGER NOT NULL
    );
  `)
}

interface ConvidadoRow {
  id: string
  nome: string
  sala: string
  dispositivo: string
  modelos_json: string
  janela: number
  limite_tokens_dia: number
  criado_em: number
  revogado_em: number | null
}

interface RecebidoRow {
  id: string
  anfitriao: string
  relay: string
  sala: string
  dispositivo: string
  modelos_json: string
  limite_tokens_dia: number
  no_roteamento: number
  criado_em: number
}

function inicioDoDia(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function urlDoRelay(base: string, caminho: string): URL {
  const url = new URL(base)
  url.pathname = url.pathname.replace(/\/$/, '') + caminho
  return url
}

export interface AnfitriaoOpcoes {
  db: Database
  secrets: SecretStore
  relayUrl: string | undefined
  nomeDispositivo: string
  ollamaBase: string
  log: (mensagem: string) => void
}

/** Lado de quem compartilha: uma sala no relay por convite, respondendo so a pedidos de modelo, com limite diario por convidado. */
export class Anfitriao {
  private readonly salas = new Map<string, SalaAnfitriao>()

  constructor(private readonly o: AnfitriaoOpcoes) {
    migrarCompartilhamento(o.db)
  }

  get relayConfigurado(): boolean {
    return Boolean(this.o.relayUrl)
  }

  iniciar(): void {
    if (!this.o.relayUrl) return
    for (const row of this.ativos()) this.abrir(row)
  }

  parar(): void {
    for (const sala of this.salas.values()) sala.parar()
    this.salas.clear()
  }

  /** Modelos que o Ollama desta maquina tem instalados. */
  async modelosLocais(): Promise<string[]> {
    try {
      const raiz = this.o.ollamaBase.replace(/\/v1\/?$/, '')
      const res = await fetch(`${raiz}/api/tags`, { signal: AbortSignal.timeout(3000) })
      const dados = (await res.json()) as { models?: { name: string }[] }
      return (dados.models ?? []).map((m) => m.name).sort()
    } catch {
      return []
    }
  }

  criar(nome: string, modelos: string[], limiteTokensDia: number, janela: number): { convite: string; convidado: ConvidadoResumo } {
    if (!this.o.relayUrl) throw new Error('configure relay_url no config.toml: o compartilhamento passa pelo relay')
    if (!nome.trim()) throw new Error('de um nome ao convidado')
    if (modelos.length === 0) throw new Error('escolha pelo menos um modelo')
    if (!Number.isInteger(limiteTokensDia) || limiteTokensDia <= 0) throw new Error('limite diario de tokens invalido')
    if (!Number.isInteger(janela) || janela < 1024) throw new Error('janela invalida')
    const row: ConvidadoRow = {
      id: randomUUID().slice(0, 12),
      nome: nome.trim(),
      sala: randomBytes(32).toString('hex'),
      dispositivo: `compartilhado-${randomUUID()}`,
      modelos_json: JSON.stringify(modelos),
      janela,
      limite_tokens_dia: limiteTokensDia,
      criado_em: Date.now(),
      revogado_em: null,
    }
    this.o.db
      .prepare('INSERT INTO convidados (id, nome, sala, dispositivo, modelos_json, janela, limite_tokens_dia, criado_em, revogado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(row.id, row.nome, this.o.secrets.seal(row.sala), row.dispositivo, row.modelos_json, row.janela, row.limite_tokens_dia, row.criado_em)
    this.abrir(row)
    const convite = codificarConvite({
      v: 1,
      relay: this.o.relayUrl,
      sala: row.sala,
      dispositivo: row.dispositivo,
      anfitriao: this.o.nomeDispositivo,
      modelos: modelos.map((m) => ({ nome: m, janela })),
      limite_tokens_dia: limiteTokensDia,
    })
    return { convite, convidado: this.resumo(row) }
  }

  revogar(id: string): void {
    const mudou = this.o.db.prepare('UPDATE convidados SET revogado_em = ? WHERE id = ? AND revogado_em IS NULL').run(Date.now(), id).changes
    if (mudou === 0) throw new Error('convite nao encontrado ou ja revogado')
    this.salas.get(id)?.parar()
    this.salas.delete(id)
  }

  listar(): ConvidadoResumo[] {
    const rows = this.o.db.prepare('SELECT * FROM convidados ORDER BY criado_em DESC').all() as ConvidadoRow[]
    return rows.map((r) => this.resumo(r))
  }

  usoHoje(id: string): number {
    const row = this.o.db.prepare('SELECT COALESCE(SUM(entrada + saida), 0) AS total FROM uso_compartilhado WHERE convidado_id = ? AND ts >= ?').get(id, inicioDoDia()) as { total: number }
    return row.total
  }

  registrarUso(id: string, modelo: string, entrada: number, saida: number, ms: number, status: number): void {
    this.o.db.prepare('INSERT INTO uso_compartilhado (convidado_id, ts, modelo, entrada, saida, ms, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, Date.now(), modelo, entrada, saida, ms, status)
  }

  private ativos(): ConvidadoRow[] {
    const rows = this.o.db.prepare('SELECT * FROM convidados WHERE revogado_em IS NULL').all() as ConvidadoRow[]
    return rows.map((r) => ({ ...r, sala: this.o.secrets.unseal(r.sala) }))
  }

  private abrir(row: ConvidadoRow): void {
    if (!this.o.relayUrl || this.salas.has(row.id)) return
    const sala = new SalaAnfitriao(this, row, this.o.relayUrl, this.o.nomeDispositivo, this.o.ollamaBase, this.o.log)
    this.salas.set(row.id, sala)
    sala.iniciar()
  }

  private resumo(r: ConvidadoRow): ConvidadoResumo {
    return {
      id: r.id,
      nome: r.nome,
      modelos: JSON.parse(r.modelos_json) as string[],
      janela: r.janela,
      limite_tokens_dia: r.limite_tokens_dia,
      uso_hoje: this.usoHoje(r.id),
      conectado: this.salas.get(r.id)?.conectado ?? false,
      criado_em: r.criado_em,
      revogado_em: r.revogado_em,
    }
  }
}

/** Uma conexao de dispositivo no relay para um convidado, com chave de ponta a ponta derivada da sala dele. */
class SalaAnfitriao {
  conectado = false
  private socket: WebSocket | null = null
  private chave: CryptoKey | null = null
  private parado = false
  private tentativas = 0
  private fila: Promise<void> = Promise.resolve()
  private readonly emAndamento = new Map<string, AbortController>()
  private readonly modelos: Set<string>

  constructor(
    private readonly anfitriao: Anfitriao,
    private readonly row: ConvidadoRow,
    private readonly relayUrl: string,
    private readonly nomeDispositivo: string,
    private readonly ollamaBase: string,
    private readonly log: (mensagem: string) => void,
  ) {
    this.modelos = new Set(JSON.parse(row.modelos_json) as string[])
  }

  iniciar(): void {
    void deriveE2eKey(this.row.sala).then((chave) => {
      this.chave = chave
      this.conectar()
    })
  }

  parar(): void {
    this.parado = true
    for (const c of this.emAndamento.values()) c.abort()
    this.socket?.close()
  }

  private conectar(): void {
    const socket = new WebSocket(urlDoRelay(this.relayUrl, '/device'), {
      headers: {
        [relayHeaders.accountToken]: this.row.sala,
        [relayHeaders.deviceId]: this.row.dispositivo,
        [relayHeaders.deviceName]: `modelos de ${this.nomeDispositivo}`,
      },
    })
    this.socket = socket
    socket.on('open', () => {
      this.conectado = true
      this.tentativas = 0
      this.log(`compartilhamento com ${this.row.nome} no ar pelo relay`)
    })
    socket.on('message', (raw) => void this.receber(JSON.parse(String(raw)) as RelayToDaemon))
    socket.on('error', (err) => this.log(`compartilhamento com ${this.row.nome}: ${err.message}`))
    socket.on('close', () => {
      this.conectado = false
      for (const c of this.emAndamento.values()) c.abort()
      if (this.parado) return
      const espera = backoffMs[Math.min(this.tentativas, backoffMs.length - 1)]!
      this.tentativas += 1
      setTimeout(() => this.conectar(), espera)
    })
  }

  private async receber(msg: RelayToDaemon): Promise<void> {
    if (msg.t === 'ping') return this.enviarBruto({ t: 'pong' })
    if (msg.t === 'trigger') return this.enviarBruto({ t: 'trigger_result', id: msg.id, accepted: false, reason: 'sala de compartilhamento nao recebe gatilhos' })
    if (msg.t !== 'frame' || !this.chave || !isSealed(msg.frame)) return
    let pedido: ParaAnfitriao
    try {
      pedido = await openFrame<ParaAnfitriao>(this.chave, msg.frame as SealedFrame)
    } catch {
      return
    }
    if (pedido.type === 'inferencia.cancelar') {
      this.emAndamento.get(pedido.id)?.abort()
      return
    }
    if (pedido.type === 'inferencia.pedido') await this.atender(msg.ch, pedido)
  }

  private async atender(ch: string, pedido: Extract<ParaAnfitriao, { type: 'inferencia.pedido' }>): Promise<void> {
    if (pedido.metodo === 'GET' && pedido.caminho === '/v1/models') {
      return this.responderJson(ch, pedido.id, 200, { object: 'list', data: [...this.modelos].map((id) => ({ id, object: 'model', owned_by: this.nomeDispositivo })) })
    }
    if (pedido.metodo !== 'POST' || pedido.caminho !== '/v1/chat/completions') {
      return this.responderErro(ch, pedido.id, 404, 'caminho nao liberado no compartilhamento: so /v1/chat/completions e /v1/models')
    }
    if (this.emAndamento.size > 0) return this.responderErro(ch, pedido.id, 429, 'ja ha um pedido deste convite em andamento; tente de novo em instantes')
    if (this.anfitriao.usoHoje(this.row.id) >= this.row.limite_tokens_dia) {
      return this.responderErro(ch, pedido.id, 429, `limite diario de ${this.row.limite_tokens_dia} tokens deste convite atingido`)
    }
    let corpo: Record<string, unknown>
    try {
      corpo = JSON.parse(pedido.corpo ?? '{}') as Record<string, unknown>
    } catch {
      return this.responderErro(ch, pedido.id, 400, 'corpo do pedido nao e JSON')
    }
    const modelo = String(corpo.model ?? '')
    if (!this.modelos.has(modelo)) return this.responderErro(ch, pedido.id, 403, `modelo ${modelo} nao foi compartilhado neste convite`)
    const pedidoMax = typeof corpo.max_tokens === 'number' ? corpo.max_tokens : tetoDeSaida
    corpo.max_tokens = Math.min(pedidoMax, tetoDeSaida)
    delete corpo.max_completion_tokens
    if (corpo.stream) corpo.stream_options = { ...(corpo.stream_options as object | undefined), include_usage: true }

    const controle = new AbortController()
    this.emAndamento.set(pedido.id, controle)
    const inicio = Date.now()
    let status = 502
    let cauda = ''
    try {
      const res = await fetch(`${this.ollamaBase.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: controle.signal,
      })
      status = res.status
      this.enviar(ch, { type: 'inferencia.resposta', id: pedido.id, status: res.status, tipo: res.headers.get('content-type') ?? 'application/json' })
      const leitor = res.body?.getReader()
      const decodificador = new TextDecoder()
      while (leitor) {
        const { done, value } = await leitor.read()
        if (done) break
        const texto = decodificador.decode(value, { stream: true })
        cauda = (cauda + texto).slice(-16000)
        this.enviar(ch, { type: 'inferencia.pedaco', id: pedido.id, dados: texto })
      }
      this.enviar(ch, { type: 'inferencia.fim', id: pedido.id })
    } catch (err) {
      if (status === 502) this.responderErro(ch, pedido.id, 502, `o Ollama de ${this.nomeDispositivo} nao respondeu: ${err instanceof Error ? err.message : String(err)}`)
      else this.enviar(ch, { type: 'inferencia.fim', id: pedido.id })
    } finally {
      this.emAndamento.delete(pedido.id)
      const uso = [...cauda.matchAll(/"usage"\s*:\s*\{[^}]*"prompt_tokens"\s*:\s*(\d+)[^}]*"completion_tokens"\s*:\s*(\d+)/g)].pop()
      this.anfitriao.registrarUso(this.row.id, modelo, uso ? Number(uso[1]) : 0, uso ? Number(uso[2]) : 0, Date.now() - inicio, status)
    }
  }

  private responderJson(ch: string, id: string, status: number, corpo: unknown): void {
    this.enviar(ch, { type: 'inferencia.resposta', id, status, tipo: 'application/json' })
    this.enviar(ch, { type: 'inferencia.pedaco', id, dados: JSON.stringify(corpo) })
    this.enviar(ch, { type: 'inferencia.fim', id })
  }

  private responderErro(ch: string, id: string, status: number, mensagem: string): void {
    this.responderJson(ch, id, status, { error: { message: mensagem } })
  }

  private enviar(ch: string, msg: ParaConvidado): void {
    const chave = this.chave
    if (!chave) return
    this.fila = this.fila.then(async () => this.enviarBruto({ t: 'frame', ch, frame: await sealFrame(chave, msg) }))
  }

  private enviarBruto(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg))
  }
}

export interface ConvidadosOpcoes {
  db: Database
  secrets: SecretStore
  porta: number
  log: (mensagem: string) => void
}

interface EventosDoPedido {
  resposta: (status: number, tipo: string) => void
  pedaco: (dados: string) => void
  fim: () => void
  erro: (mensagem: string) => void
}

/** Lado de quem recebe: guarda os convites, vira agentes locais e leva os pedidos de modelo pelo relay ate o anfitriao. */
export class Convidados {
  private readonly conexoes = new Map<string, ConexaoConvidado>()

  constructor(private readonly o: ConvidadosOpcoes) {
    migrarCompartilhamento(o.db)
  }

  parar(): void {
    for (const c of this.conexoes.values()) c.fechar()
    this.conexoes.clear()
  }

  adicionar(texto: string, noRoteamento: boolean): RecebidoResumo {
    const convite = lerConvite(texto)
    const id = createHash('sha256').update(convite.sala).digest('hex').slice(0, 12)
    this.o.db
      .prepare(
        `INSERT INTO recebidos (id, anfitriao, relay, sala, dispositivo, modelos_json, limite_tokens_dia, no_roteamento, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET anfitriao = excluded.anfitriao, relay = excluded.relay, dispositivo = excluded.dispositivo, modelos_json = excluded.modelos_json, limite_tokens_dia = excluded.limite_tokens_dia, no_roteamento = excluded.no_roteamento`,
      )
      .run(id, convite.anfitriao, convite.relay, this.o.secrets.seal(convite.sala), convite.dispositivo, JSON.stringify(convite.modelos), convite.limite_tokens_dia, noRoteamento ? 1 : 0, Date.now())
    this.conexoes.get(id)?.fechar()
    this.conexoes.delete(id)
    return this.listar().find((r) => r.id === id)!
  }

  remover(id: string): void {
    if (this.o.db.prepare('DELETE FROM recebidos WHERE id = ?').run(id).changes === 0) throw new Error('convite recebido nao encontrado')
    this.conexoes.get(id)?.fechar()
    this.conexoes.delete(id)
  }

  listar(): RecebidoResumo[] {
    return this.rows().map((r) => {
      const modelos = JSON.parse(r.modelos_json) as { nome: string; janela: number }[]
      return {
        id: r.id,
        anfitriao: r.anfitriao,
        modelos,
        agentes: modelos.map((m) => nomeDoAgente(r.anfitriao, m.nome)),
        limite_tokens_dia: r.limite_tokens_dia,
        no_roteamento: r.no_roteamento === 1,
        criado_em: r.criado_em,
      }
    })
  }

  /** Um perfil por modelo recebido, apontando para o endereco local que atravessa o relay. */
  perfis(): AgentProfile[] {
    return this.rows().flatMap((r) => (JSON.parse(r.modelos_json) as { nome: string; janela: number }[]).map((m) => perfilCompartilhado(r, m, this.o.porta)))
  }

  async testar(id: string): Promise<{ ok: boolean; detalhe: string; ms: number }> {
    const inicio = Date.now()
    return new Promise((resolve) => {
      let status = 0
      let corpo = ''
      this.encaminhar(id, 'GET', '/v1/models', undefined, {
        resposta: (s) => (status = s),
        pedaco: (d) => (corpo += d),
        fim: () => {
          const ms = Date.now() - inicio
          if (status !== 200) return resolve({ ok: false, detalhe: `anfitriao respondeu ${status}: ${corpo.slice(0, 200)}`, ms })
          try {
            const nomes = ((JSON.parse(corpo) as { data?: { id: string }[] }).data ?? []).map((m) => m.id)
            resolve({ ok: true, detalhe: `conectado; modelos liberados: ${nomes.join(', ')}`, ms })
          } catch {
            resolve({ ok: false, detalhe: `resposta ilegivel do anfitriao: ${corpo.slice(0, 200)}`, ms })
          }
        },
        erro: (mensagem) => resolve({ ok: false, detalhe: mensagem, ms: Date.now() - inicio }),
      })
    })
  }

  /** Leva um pedido HTTP ao anfitriao e devolve a resposta em pedacos; o retorno cancela o pedido. */
  encaminhar(id: string, metodo: 'GET' | 'POST', caminho: string, corpo: string | undefined, eventos: EventosDoPedido): () => void {
    const row = this.rows().find((r) => r.id === id)
    if (!row) {
      eventos.erro('convite recebido nao encontrado')
      return () => undefined
    }
    let conexao = this.conexoes.get(id)
    if (!conexao || conexao.fechada) {
      conexao = new ConexaoConvidado(row.relay, this.o.secrets.unseal(row.sala), row.dispositivo, row.anfitriao)
      this.conexoes.set(id, conexao)
    }
    return conexao.pedir(metodo, caminho, corpo, eventos)
  }

  private rows(): RecebidoRow[] {
    return this.o.db.prepare('SELECT * FROM recebidos ORDER BY criado_em').all() as RecebidoRow[]
  }
}

/** Conexao de cliente no relay, na sala do convite, anexada ao dispositivo do anfitriao. */
class ConexaoConvidado {
  fechada = false
  private fila: Promise<void> = Promise.resolve()
  private readonly socket: WebSocket
  private readonly pronta: Promise<CryptoKey>
  private readonly pedidos = new Map<string, EventosDoPedido>()

  constructor(relay: string, sala: string, dispositivo: string, anfitriao: string) {
    this.socket = new WebSocket(urlDoRelay(relay, '/client'))
    this.pronta = new Promise<CryptoKey>((resolve, rejeitar) => {
      const reject = (err: Error) => {
        clearTimeout(prazo)
        rejeitar(err)
        this.fechar()
      }
      const prazo = setTimeout(() => reject(new Error(`${anfitriao} nao respondeu pelo relay em 10 s`)), 10_000)
      const chave = deriveE2eKey(sala)
      this.socket.on('open', () => this.socket.send(JSON.stringify({ type: 'relay.auth', account_token: sala, client: 'agent-hub-convidado' })))
      this.socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as RelayToClient
        if (isSealed(msg)) {
          this.fila = this.fila.then(async () => {
            try {
              this.despachar(await openFrame<ParaConvidado>(await chave, msg as SealedFrame))
            } catch {
              return
            }
          })
          return
        }
        const quadro = msg as { type: string; devices?: { id: string }[]; message?: string; reason?: string }
        if (quadro.type === 'relay.devices') {
          if (quadro.devices?.some((d) => d.id === dispositivo)) this.socket.send(JSON.stringify({ type: 'relay.attach', device_id: dispositivo }))
          else reject(new Error(`${anfitriao} nao esta disponivel: o daemon dele esta desligado ou o convite foi revogado`))
          return
        }
        if (quadro.type === 'relay.attached') {
          clearTimeout(prazo)
          void chave.then(resolve)
          return
        }
        if (quadro.type === 'relay.error' || quadro.type === 'relay.detached') {
          const motivo = quadro.message ?? quadro.reason ?? 'relay recusou'
          reject(new Error(motivo))
          this.falharTudo(`conexao com ${anfitriao} caiu: ${motivo}`)
        }
      })
      this.socket.on('error', (err) => {
        reject(err)
        this.falharTudo(`relay inacessivel: ${err.message}`)
      })
      this.socket.on('close', () => {
        this.fechada = true
        reject(new Error('conexao com o relay fechada'))
        this.falharTudo(`conexao com ${anfitriao} fechada`)
      })
    })
    this.pronta.catch(() => (this.fechada = true))
  }

  pedir(metodo: 'GET' | 'POST', caminho: string, corpo: string | undefined, eventos: EventosDoPedido): () => void {
    const id = randomUUID()
    this.pedidos.set(id, eventos)
    this.pronta.then(
      async (chave) => this.socket.send(JSON.stringify(await sealFrame(chave, { type: 'inferencia.pedido', id, metodo, caminho, corpo } satisfies ParaAnfitriao))),
      (err: unknown) => {
        this.pedidos.delete(id)
        eventos.erro(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      if (!this.pedidos.delete(id)) return
      void this.pronta.then(async (chave) => {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(await sealFrame(chave, { type: 'inferencia.cancelar', id } satisfies ParaAnfitriao)))
      }, () => undefined)
    }
  }

  fechar(): void {
    this.fechada = true
    this.socket.close()
  }

  private despachar(msg: ParaConvidado): void {
    const eventos = this.pedidos.get(msg.id)
    if (!eventos) return
    try {
      if (msg.type === 'inferencia.resposta') eventos.resposta(msg.status, msg.tipo)
      else if (msg.type === 'inferencia.pedaco') eventos.pedaco(msg.dados)
      else if (msg.type === 'inferencia.fim') {
        this.pedidos.delete(msg.id)
        eventos.fim()
      }
    } catch (err) {
      this.pedidos.delete(msg.id)
      eventos.erro(err instanceof Error ? err.message : String(err))
    }
  }

  private falharTudo(mensagem: string): void {
    for (const eventos of this.pedidos.values()) eventos.erro(mensagem)
    this.pedidos.clear()
  }
}

function slug(texto: string): string {
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function nomeDoAgente(anfitriao: string, modelo: string): string {
  return `compartilhado-${slug(anfitriao)}-${slug(modelo)}`
}

function perfilCompartilhado(r: RecebidoRow, modelo: { nome: string; janela: number }, porta: number): AgentProfile {
  const texto = [
    '---',
    `name: ${nomeDoAgente(r.anfitriao, modelo.nome)}`,
    `description: ${JSON.stringify(`Modelo ${modelo.nome} compartilhado por ${r.anfitriao}; roda na maquina de quem compartilhou, pelo relay`)}`,
    'provider: ollama',
    `model: ${JSON.stringify(modelo.nome)}`,
    'reasoning: low',
    'max_output: 4000',
    'max_steps: 20',
    'tools:',
    '  native: [list_dir, read_file, search, edit_file, write_file, run_command, git, memory_read, knowledge_search]',
    '  mcp: []',
    'skills: []',
    'routing:',
    '  capabilities:',
    `    "*": ${r.no_roteamento === 1 ? 0 : 0.5}`,
    `  max_prompt_tokens: ${Math.floor(modelo.janela / 2)}`,
    'policy: padrao',
    'budget:',
    '  run_usd: 0',
    'context:',
    `  window: ${modelo.janela}`,
    '  compact_at: 0.8',
    'repair_attempts: 2',
    'provider_options:',
    `  base_url: ${JSON.stringify(`http://127.0.0.1:${porta}/compartilhado/${r.id}/v1`)}`,
    '  temperature: 0',
    '  extra_body:',
    '    reasoning_effort: none',
    '---',
    '',
    `Voce trabalha no workspace do usuario. O modelo roda na maquina de ${r.anfitriao}, mas as ferramentas, os arquivos e as aprovacoes ficam aqui.`,
    'Leia antes de mudar, cite arquivo e linha, e seja direto. Sem emojis.',
    '',
  ].join('\n')
  return parseProfile(`compartilhado:${r.id}:${modelo.nome}`, texto)
}

/** Endereco local no formato da OpenAI que o adaptador do agente compartilhado usa; so a propria maquina chama. */
export function registrarRotasDeCompartilhamento(app: FastifyInstance, convidados: Convidados, local: (ip: string) => boolean): void {
  const atender = (metodo: 'GET' | 'POST', caminho: string) => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!local(req.ip)) return reply.code(403).send({ error: { message: 'so a propria maquina usa o compartilhamento' } })
    reply.hijack()
    const raw = reply.raw
    let comecou = false
    let terminou = false
    const corpo = metodo === 'POST' ? JSON.stringify(req.body ?? {}) : undefined
    const cancelar = convidados.encaminhar(req.params.id, metodo, caminho, corpo, {
      resposta: (status, tipo) => {
        comecou = true
        raw.writeHead(status, { 'content-type': tipo, 'cache-control': 'no-cache' })
      },
      pedaco: (dados) => raw.write(dados),
      fim: () => {
        terminou = true
        raw.end()
      },
      erro: (mensagem) => {
        terminou = true
        if (!comecou) raw.writeHead(502, { 'content-type': 'application/json' })
        raw.end(comecou ? undefined : JSON.stringify({ error: { message: mensagem } }))
      },
    })
    raw.on('close', () => {
      if (!terminou) cancelar()
    })
  }
  app.get('/compartilhado/:id/v1/models', atender('GET', '/v1/models'))
  app.post('/compartilhado/:id/v1/chat/completions', atender('POST', '/v1/chat/completions'))
}
