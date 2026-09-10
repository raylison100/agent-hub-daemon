import { randomUUID } from 'node:crypto'
import { spawn, type IPty } from 'node-pty'

export interface TerminalOptions {
  cwd: string
  cols: number
  rows: number
  env: NodeJS.ProcessEnv
  onData: (data: string) => void
  onExit: (code: number) => void
}

interface Sessao {
  pty: IPty
  cwd: string
}

const shellPadrao = process.env.SHELL || '/bin/bash'
const scrollbackMax = 200_000

/** Terminais interativos por sessao, cada um com um shell no workspace escolhido. */
export class Terminals {
  private readonly abertos = new Map<string, Sessao>()
  private readonly historico = new Map<string, string>()

  open(opts: TerminalOptions): string {
    const id = randomUUID()
    const pty = spawn(shellPadrao, ['-l'], {
      name: 'xterm-256color',
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: { ...opts.env, TERM: 'xterm-256color' } as Record<string, string>,
    })
    this.abertos.set(id, { pty, cwd: opts.cwd })
    this.historico.set(id, '')
    pty.onData((data) => {
      const anterior = this.historico.get(id) ?? ''
      this.historico.set(id, (anterior + data).slice(-scrollbackMax))
      opts.onData(data)
    })
    pty.onExit(({ exitCode }) => {
      this.abertos.delete(id)
      opts.onExit(exitCode)
    })
    return id
  }

  write(id: string, data: string): void {
    this.abertos.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const sessao = this.abertos.get(id)
    if (!sessao) return
    sessao.pty.resize(Math.max(2, cols), Math.max(2, rows))
  }

  /** Tudo que ja saiu neste terminal, para quem reabre a aba nao ver a tela em branco. */
  buffer(id: string): string {
    return this.historico.get(id) ?? ''
  }

  has(id: string): boolean {
    return this.abertos.has(id)
  }

  close(id: string): void {
    const sessao = this.abertos.get(id)
    if (!sessao) return
    sessao.pty.kill()
    this.abertos.delete(id)
    this.historico.delete(id)
  }

  closeAll(): void {
    for (const id of [...this.abertos.keys()]) this.close(id)
  }
}
