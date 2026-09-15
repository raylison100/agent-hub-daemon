import type { CanalId } from '@agent-hub/core'

export interface Pessoa {
  id: string
  nome?: string
  usuario?: string
}

export interface MensagemRecebida {
  conversa: string
  remetente: Pessoa
  texto: string
}

export interface BotaoRecebido {
  conversa: string
  remetente: Pessoa
  dados: string
  confirmar(texto: string): Promise<void>
}

export interface Botao {
  texto: string
  dados: string
}

export interface EventosDoTransporte {
  mensagem(m: MensagemRecebida): void
  botao(b: BotaoRecebido): void
  log(texto: string): void
}

/** Conexao ativa com um canal: recebe mensagens e envia respostas numa conversa. */
export interface Transporte {
  iniciar(eventos: EventosDoTransporte): void
  parar(): void
  enviar(conversa: string, texto: string, botoes?: Botao[][]): Promise<void>
}

export interface CampoDoCanal {
  chave: string
  rotulo: string
  segredo: boolean
  obrigatorio: boolean
  ajuda?: string
  exemplo?: string
}

/** Tipo de canal suportado: campos que a tela pede, passo a passo, validacao e fabrica do transporte. */
export interface TipoDeCanal {
  id: CanalId
  nome: string
  descricao: string
  passos: string[]
  campos: CampoDoCanal[]
  botoes: boolean
  link(conta: string): string | null
  validar(valores: Record<string, string>): Promise<{ conta: string }>
  criar(valores: Record<string, string>): Transporte
}
