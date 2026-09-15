import type { EventosDoTransporte, TipoDeCanal, Transporte } from './tipos.js'

interface Conversa {
  remoteJid: string
  name?: string | null
  isGroup?: boolean
  lastMessageAt?: string | null
}

interface Mensagem {
  messageId: string
  remoteJid: string
  fromMe: boolean
  type: string
  content: { text?: string; caption?: string } | null
  timestamp: number
}

const intervaloMs = 4000
const maxMensagem = 4000

/** Cliente da API HTTP de WhatsApp por instancia: conversas, mensagens e envio de texto com chave no cabecalho x-api-key. */
export class WhatsAppApi {
  private readonly base: string

  constructor(
    url: string,
    private readonly chave: string,
    private readonly instancia: string,
  ) {
    const limpa = url.trim().replace(/\/+$/, '')
    this.base = /\/v1$/.test(limpa) ? limpa : `${limpa}/v1`
  }

  instanciaInfo(): Promise<{ name: string; displayName?: string; phone?: string; status: string }> {
    return this.chamar('GET', '')
  }

  conversas(): Promise<{ chats: Conversa[] }> {
    return this.chamar('GET', '/chats?limit=20')
  }

  mensagens(remoteJid: string): Promise<{ messages: Mensagem[] }> {
    return this.chamar('GET', `/messages?remoteJid=${encodeURIComponent(remoteJid)}&limit=10`)
  }

  async enviarTexto(destino: string, texto: string): Promise<void> {
    for (const parte of dividir(texto)) await this.chamar('POST', '/send/text', { phone: destino, text: parte })
  }

  private async chamar<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/instances/${encodeURIComponent(this.instancia)}${caminho}`, {
      method: metodo,
      headers: { 'x-api-key': this.chave, ...(corpo ? { 'content-type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    })
    const texto = await res.text()
    const json = texto ? (JSON.parse(texto) as T & { error?: string; message?: string }) : ({} as T & { error?: string; message?: string })
    if (!res.ok) throw new Error(json.error ?? json.message ?? `HTTP ${res.status}`)
    return json
  }
}

class TransporteWhatsApp implements Transporte {
  private timer: ReturnType<typeof setTimeout> | null = null
  private parado = true
  private readonly vistos = new Set<string>()
  private readonly ultimaNaConversa = new Map<string, string>()
  private desde = 0

  constructor(private readonly api: WhatsAppApi) {}

  iniciar(eventos: EventosDoTransporte): void {
    this.parado = false
    this.desde = Math.floor(Date.now() / 1000) - 5
    const rodada = async (): Promise<void> => {
      try {
        await this.buscar(eventos)
      } catch (err) {
        eventos.log(`leitura das conversas: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!this.parado) this.timer = setTimeout(() => void rodada(), intervaloMs)
    }
    void rodada()
  }

  parar(): void {
    this.parado = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  enviar(conversa: string, texto: string): Promise<void> {
    return this.api.enviarTexto(conversa, texto)
  }

  private async buscar(eventos: EventosDoTransporte): Promise<void> {
    const { chats } = await this.api.conversas()
    for (const chat of chats) {
      if (chat.isGroup || chat.remoteJid.endsWith('@g.us') || !chat.lastMessageAt) continue
      if (new Date(chat.lastMessageAt).getTime() / 1000 < this.desde) continue
      if (this.ultimaNaConversa.get(chat.remoteJid) === chat.lastMessageAt) continue
      this.ultimaNaConversa.set(chat.remoteJid, chat.lastMessageAt)
      const { messages } = await this.api.mensagens(chat.remoteJid)
      for (const m of messages) {
        const segundos = m.timestamp > 1e12 ? Math.floor(m.timestamp / 1000) : m.timestamp
        const texto = m.content?.text ?? m.content?.caption
        if (m.fromMe || segundos < this.desde || this.vistos.has(m.messageId) || !texto) continue
        this.vistos.add(m.messageId)
        eventos.mensagem({ conversa: m.remoteJid, remetente: pessoa(m.remoteJid, chat.name ?? undefined), texto })
      }
    }
    if (this.vistos.size > 2000) for (const id of [...this.vistos].slice(0, 1000)) this.vistos.delete(id)
  }
}

export const whatsapp: TipoDeCanal = {
  id: 'whatsapp',
  nome: 'WhatsApp por API',
  descricao: 'Um numero de WhatsApp conectado a um provedor com API HTTP por instancia. Converse com os agentes pelo WhatsApp.',
  passos: [
    'No painel do provedor, crie uma instancia so para o Agent Hub e conecte um numero dedicado, para os agentes nunca lerem conversas pessoais.',
    'Desligue a IA de atendimento do provedor nessa instancia, senao ela responde junto com os agentes.',
    'Gere uma chave de API no painel e cole abaixo com o endereco da API e o nome (slug) da instancia. O Agent Hub confere a conexao.',
    'Ligue o canal e mande qualquer mensagem de WhatsApp para esse numero. Voce aparece em "Pediram acesso": clique em Permitir.',
    'Aprovacoes chegam como texto: responda /aprovar <codigo> ou /negar <codigo>.',
  ],
  campos: [
    { chave: 'url', rotulo: 'Endereco da API', segredo: false, obrigatorio: true, exemplo: 'https://api.exemplo.com' },
    { chave: 'instancia', rotulo: 'Instancia', segredo: false, obrigatorio: true, exemplo: 'agent-hub', ajuda: 'O nome (slug) da instancia, como aparece na URL de envio.' },
    { chave: 'chave', rotulo: 'Chave de API', segredo: true, obrigatorio: true },
  ],
  botoes: false,
  link: () => null,
  async validar(valores) {
    const api = new WhatsAppApi(valores.url ?? '', valores.chave ?? '', valores.instancia ?? '')
    const info = await api.instanciaInfo().catch((err: unknown) => {
      throw new Error(`a API recusou a conexao: ${err instanceof Error ? err.message : String(err)}`)
    })
    if (info.status !== 'CONNECTED') throw new Error(`a instancia ${info.name} esta ${info.status}; conecte o numero no painel do provedor antes`)
    return { conta: info.phone ? `+${info.phone}` : (info.displayName ?? info.name) }
  },
  criar(valores) {
    return new TransporteWhatsApp(new WhatsAppApi(valores.url ?? '', valores.chave ?? '', valores.instancia ?? ''))
  },
}

function pessoa(remoteJid: string, nome?: string): { id: string; nome?: string } {
  const [usuario, dominio] = remoteJid.split('@')
  return { id: dominio === 's.whatsapp.net' ? (usuario ?? remoteJid) : remoteJid, nome }
}

function dividir(texto: string): string[] {
  if (texto.length <= maxMensagem) return [texto || '(vazio)']
  const partes: string[] = []
  for (let i = 0; i < texto.length; i += maxMensagem) partes.push(texto.slice(i, i + maxMensagem))
  return partes
}
