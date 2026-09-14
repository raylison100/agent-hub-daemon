import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EstadoDaVersao } from '@agent-hub/core'
import { currentCli, systemdAvailable } from './install.js'

const repositorio = 'raylison100/agent-hub'
const validadeDaConsultaMs = 6 * 60 * 60 * 1000

export interface UltimaVersao {
  versao: string
  publicada_em: string
  endereco: string
}

export interface OpcoesDaAtualizacao {
  home: string
  fonte?: string
  supervisionado: () => boolean
  buscar?: () => Promise<UltimaVersao>
  disparar?: (pacote: string) => void
}

/** Versao do daemon lida do package.json ao lado da pasta dist. */
export function versaoInstalada(): string {
  const arquivo = fileURLToPath(new URL('../package.json', import.meta.url))
  return (JSON.parse(readFileSync(arquivo, 'utf8')) as { version: string }).version
}

/** Diz se o daemon roda de um clone do repositorio ou do pacote instalado pelo npm. */
export function tipoDeInstalacao(): 'pacote' | 'repositorio' {
  return existsSync(fileURLToPath(new URL('../.git', import.meta.url))) ? 'repositorio' : 'pacote'
}

/** Commits depois da tag da versao em cada repositorio vizinho do clone, para quem roda do codigo. */
export function commitsNaoLancados(versao: string): { repositorio: string; commits: number }[] {
  const raiz = fileURLToPath(new URL('../..', import.meta.url))
  const out: { repositorio: string; commits: number }[] = []
  for (const nome of ['core', 'daemon', 'web', 'agents', 'desktop']) {
    const dir = join(raiz, nome)
    if (!existsSync(join(dir, '.git'))) continue
    const r = spawnSync('git', ['-C', dir, 'rev-list', '--count', `v${versao}..HEAD`], { encoding: 'utf8' })
    const commits = Number(r.stdout.trim())
    if (r.status === 0 && commits > 0) out.push({ repositorio: nome, commits })
  }
  return out
}

/** Compara duas versoes SemVer; versao com sufixo de pre-lancamento vale menos que a mesma sem sufixo. */
export function compararVersoes(a: string, b: string): number {
  const partes = (v: string) => {
    const [numeros, pre] = v.replace(/^v/, '').split('-', 2)
    return { n: (numeros ?? '').split('.').map((x) => Number(x) || 0), pre: pre ?? '' }
  }
  const pa = partes(a)
  const pb = partes(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa.n[i] ?? 0) - (pb.n[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre < pb.pre ? -1 : 1
}

/** Consulta a ultima Release publicada no GitHub. */
export async function buscarUltimaVersao(fonte = `https://api.github.com/repos/${repositorio}/releases/latest`): Promise<UltimaVersao> {
  const resposta = await fetch(fonte, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-hub' }, signal: AbortSignal.timeout(10_000) })
  if (!resposta.ok) throw new Error(`GitHub respondeu ${resposta.status} ao consultar a ultima versao`)
  const corpo = (await resposta.json()) as { tag_name?: string; published_at?: string; html_url?: string }
  if (!corpo.tag_name) throw new Error('a Release mais recente veio sem tag')
  return { versao: corpo.tag_name.replace(/^v/, ''), publicada_em: corpo.published_at ?? '', endereco: corpo.html_url ?? `https://github.com/${repositorio}/releases` }
}

/** Endereco do pacote .tgz de uma versao publicada. */
export function enderecoDoPacote(versao: string): string {
  return `https://github.com/${repositorio}/releases/download/v${versao}/agent-hub-${versao}.tgz`
}

/** Roda o comando atualizar numa unidade transitoria do systemd, fora do grupo do servico que vai ser reiniciado. */
export function dispararPeloSystemd(home: string, pacote: string): void {
  const caminho = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? '').split(':').filter(Boolean), '/usr/local/bin', '/usr/bin', '/bin'])].join(':')
  const log = join(home, 'atualizacao.log')
  const args = [
    '--user',
    '--collect',
    `--unit=agent-hub-atualizacao-${Date.now()}`,
    `--setenv=PATH=${caminho}`,
    ...(process.env.AGENT_HUB_HOME ? [`--setenv=AGENT_HUB_HOME=${process.env.AGENT_HUB_HOME}`] : []),
    `-p`,
    `StandardOutput=append:${log}`,
    `-p`,
    `StandardError=append:${log}`,
    process.execPath,
    currentCli(),
    'atualizar',
    pacote,
  ]
  const filho = spawn('systemd-run', args, { stdio: 'ignore', detached: true })
  filho.unref()
}

/** Guarda o estado da versao do daemon, consulta a Release com cache e dispara a atualizacao. */
export class Atualizacao {
  private ultima: UltimaVersao | null = null
  private consultadoEm: number | null = null
  private erro = ''
  private atualizando = false

  constructor(private readonly opcoes: OpcoesDaAtualizacao) {}

  async estado(forcar = false): Promise<EstadoDaVersao> {
    const vencida = this.consultadoEm === null || Date.now() - this.consultadoEm > validadeDaConsultaMs
    if (forcar || vencida) {
      try {
        this.ultima = await (this.opcoes.buscar ?? (() => buscarUltimaVersao(this.opcoes.fonte)))()
        this.erro = ''
      } catch (err) {
        this.erro = err instanceof Error ? err.message : String(err)
      }
      this.consultadoEm = Date.now()
    }
    return this.montar()
  }

  async atualizar(): Promise<EstadoDaVersao> {
    const atual = await this.estado(true)
    if (!atual.pode_atualizar || !this.ultima) throw new Error(atual.detalhe)
    this.atualizando = true
    const pacote = enderecoDoPacote(this.ultima.versao)
    ;(this.opcoes.disparar ?? ((p) => dispararPeloSystemd(this.opcoes.home, p)))(pacote)
    return this.montar()
  }

  private montar(): EstadoDaVersao {
    const atual = versaoInstalada()
    const instalacao = tipoDeInstalacao()
    const supervisionado = this.opcoes.supervisionado()
    const naoLancadas = instalacao === 'repositorio' ? commitsNaoLancados(atual) : []
    const disponivel = this.ultima !== null && compararVersoes(this.ultima.versao, atual) > 0
    const podeAtualizar = disponivel && instalacao === 'pacote' && supervisionado && !this.atualizando
    return {
      atual,
      ultima: this.ultima?.versao ?? null,
      publicada_em: this.ultima?.publicada_em ?? null,
      endereco_da_versao: this.ultima?.endereco ?? null,
      disponivel,
      instalacao,
      nao_lancadas: naoLancadas,
      supervisionado,
      pode_atualizar: podeAtualizar,
      atualizando: this.atualizando,
      detalhe: this.detalhe(atual, instalacao, supervisionado, disponivel, naoLancadas),
      consultado_em: this.consultadoEm,
    }
  }

  private detalhe(atual: string, instalacao: 'pacote' | 'repositorio', supervisionado: boolean, disponivel: boolean, naoLancadas: { repositorio: string; commits: number }[]): string {
    if (this.atualizando) return `baixando a versao ${this.ultima?.versao}; o daemon reinicia sozinho e a interface reconecta. Registro em ${join(this.opcoes.home, 'atualizacao.log')}`
    if (this.erro && !this.ultima) return `nao foi possivel consultar a ultima versao: ${this.erro}`
    if (!this.ultima) return 'ainda nao consultado'
    if (!disponivel && naoLancadas.length > 0) {
      const lista = naoLancadas.map((n) => `${n.repositorio} ${n.commits}`).join(', ')
      return `este daemon roda do codigo, a frente da versao ${atual} (commits ainda nao lancados: ${lista}). O app de desktop e o pacote so recebem essas mudancas quando sair a proxima versao: make versao`
    }
    if (!disponivel) return `versao ${atual} e a mais recente`
    if (instalacao === 'repositorio') return `a versao ${this.ultima.versao} saiu; este daemon roda de um clone do repositorio, entao atualize com git pull e make build`
    if (!supervisionado) return `a versao ${this.ultima.versao} saiu; o daemon nao roda pelo servico do systemd, entao atualize no terminal com: agent-hub atualizar ${enderecoDoPacote(this.ultima.versao)}`
    return `a versao ${this.ultima.versao} saiu e pode ser instalada daqui`
  }
}

/** Confere se o systemd-run existe para disparar a atualizacao fora do servico. */
export function systemdRunDisponivel(): boolean {
  return systemdAvailable() && spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status === 0
}
