import type { Botao, EventosDoTransporte, ImagemParaEnviar, TipoDeCanal, Transporte } from './tipos.js'

interface TelegramUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

interface TelegramMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: TelegramUser
  text?: string
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
}

const maxMessage = 4000

/** Cliente minimo da Bot API do Telegram. */
export class TelegramApi {
  constructor(private readonly token: string) {}

  me(): Promise<{ id: number; first_name: string; username: string }> {
    return this.call('getMe', {})
  }

  async *updates(signal: AbortSignal, log: (t: string) => void): AsyncGenerator<TelegramUpdate> {
    let offset = 0
    while (!signal.aborted) {
      try {
        const res = await this.call<TelegramUpdate[]>('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, signal)
        for (const u of res) {
          offset = u.update_id + 1
          yield u
        }
      } catch (err) {
        if (signal.aborted) return
        log(`getUpdates: ${err instanceof Error ? err.message : String(err)}`)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }

  async send(chatId: string, text: string, botoes?: Botao[][]): Promise<void> {
    for (const chunk of split(text)) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        reply_markup: botoes ? { inline_keyboard: botoes.map((l) => l.map((b) => ({ text: b.texto, callback_data: b.dados }))) } : undefined,
      })
    }
  }

  /** Foto de perfil pequena do usuario, baixada pelo daemon para o token nao sair da maquina. */
  async fotoDoUsuario(userId: string): Promise<{ mediaType: string; base64: string } | null> {
    const fotos = await this.call<{ photos: { file_id: string; width: number }[][] }>('getUserProfilePhotos', { user_id: Number(userId), limit: 1 })
    const tamanhos = fotos.photos[0]
    if (!tamanhos || tamanhos.length === 0) return null
    const escolhida = tamanhos.find((t) => t.width >= 160) ?? tamanhos[tamanhos.length - 1]!
    const arquivo = await this.call<{ file_path?: string }>('getFile', { file_id: escolhida.file_id })
    if (!arquivo.file_path) return null
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${arquivo.file_path}`, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) return null
    return { mediaType: res.headers.get('content-type')?.startsWith('image/') ? res.headers.get('content-type')! : 'image/jpeg', base64: Buffer.from(await res.arrayBuffer()).toString('base64') }
  }

  async sendPhoto(chatId: string, imagem: ImagemParaEnviar): Promise<void> {
    const form = new FormData()
    form.append('chat_id', chatId)
    if (imagem.legenda) form.append('caption', imagem.legenda.slice(0, 1024))
    const campo = imagem.bytes.length > 9_500_000 ? 'document' : 'photo'
    form.append(campo, new Blob([new Uint8Array(imagem.bytes)], { type: imagem.mediaType }), imagem.nome)
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${campo === 'photo' ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
    const json = (await res.json()) as { ok: boolean; description?: string }
    if (!json.ok) throw new Error(json.description ?? `HTTP ${res.status}`)
  }

  async answerCallback(id: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text })
  }

  async clearButtons(chatId: number, messageId: number): Promise<void> {
    await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20000),
    })
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
    if (!json.ok || json.result === undefined) throw new Error(json.description ?? `HTTP ${res.status}`)
    return json.result
  }
}

class TransporteTelegram implements Transporte {
  private controller: AbortController | null = null

  constructor(private readonly api: TelegramApi) {}

  iniciar(eventos: EventosDoTransporte): void {
    this.controller = new AbortController()
    const signal = this.controller.signal
    void (async () => {
      for await (const u of this.api.updates(signal, eventos.log)) {
        const m = u.message
        if (m?.from && m.text) {
          eventos.mensagem({ conversa: String(m.chat.id), remetente: pessoa(m.from), texto: m.text })
        }
        const cb = u.callback_query
        if (cb?.data) {
          eventos.botao({
            conversa: String(cb.message?.chat.id ?? cb.from.id),
            remetente: pessoa(cb.from),
            dados: cb.data,
            confirmar: async (texto) => {
              await this.api.answerCallback(cb.id, texto)
              if (cb.message) await this.api.clearButtons(cb.message.chat.id, cb.message.message_id).catch(() => undefined)
            },
          })
        }
      }
    })()
  }

  parar(): void {
    this.controller?.abort()
    this.controller = null
  }

  enviar(conversa: string, texto: string, botoes?: Botao[][]): Promise<void> {
    return this.api.send(conversa, texto, botoes)
  }

  enviarImagem(conversa: string, imagem: ImagemParaEnviar): Promise<void> {
    return this.api.sendPhoto(conversa, imagem)
  }
}

export const telegram: TipoDeCanal = {
  id: 'telegram',
  nome: 'Telegram',
  descricao: 'Bot gratuito do Telegram. Converse com os agentes, receba as respostas das automacoes e aprove ferramentas pelo celular.',
  passos: [
    'No Telegram, abra uma conversa com @BotFather e envie /newbot.',
    'Escolha um nome e um usuario terminado em "bot". O BotFather responde com o token do bot.',
    'Cole o token abaixo e salve. O Agent Hub confere o token e mostra o nome do bot.',
    'Ligue o canal, abra o bot pelo link que aparece ao lado da conta e mande qualquer mensagem. Voce aparece em "Pediram acesso": clique em Permitir.',
    'Com a pessoa permitida, use "Enviar mensagem de teste" para conferir.',
  ],
  campos: [{ chave: 'token', rotulo: 'Token do bot', segredo: true, obrigatorio: true, exemplo: '123456789:AA...' }],
  botoes: true,
  link: (conta) => `https://t.me/${conta.replace(/^@/, '')}`,
  rotuloDoId: 'ID do Telegram',
  foto: (valores, pessoa) => new TelegramApi(valores.token ?? '').fotoDoUsuario(pessoa),
  async validar(valores) {
    const me = await new TelegramApi(valores.token ?? '').me().catch((err: unknown) => {
      throw new Error(`token recusado pelo Telegram: ${err instanceof Error ? err.message : String(err)}`)
    })
    return { conta: `@${me.username}` }
  },
  criar(valores) {
    return new TransporteTelegram(new TelegramApi(valores.token ?? ''))
  },
}

function pessoa(u: TelegramUser): { id: string; nome?: string; usuario?: string } {
  const nome = [u.first_name, u.last_name].filter(Boolean).join(' ') || undefined
  return { id: String(u.id), nome, usuario: u.username }
}

function split(text: string): string[] {
  if (text.length <= maxMessage) return [text || '(vazio)']
  const parts: string[] = []
  for (let i = 0; i < text.length; i += maxMessage) parts.push(text.slice(i, i + maxMessage))
  return parts
}
