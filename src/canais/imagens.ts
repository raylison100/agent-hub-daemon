import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import type { ImagemParaEnviar } from './tipos.js'

const tipos: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const limiteBytes = 20 * 1024 * 1024
const padrao = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/

/** Separa as linhas de imagem em markdown do texto e carrega os arquivos que existem dentro do workspace. */
export function separarImagens(texto: string, workspace: string): { texto: string; imagens: ImagemParaEnviar[]; recusadas: string[] } {
  const raiz = resolve(workspace)
  const imagens: ImagemParaEnviar[] = []
  const recusadas: string[] = []
  const linhas: string[] = []
  for (const linha of texto.split('\n')) {
    const achado = padrao.exec(linha)
    if (!achado) {
      linhas.push(linha)
      continue
    }
    const [, legenda, alvo] = achado
    const caminho = isAbsolute(alvo!) ? resolve(alvo!) : resolve(raiz, alvo!)
    const tipo = tipos[extname(caminho).toLowerCase()]
    const dentro = caminho === raiz || caminho.startsWith(raiz + sep)
    if (!tipo || !dentro || !existsSync(caminho) || statSync(caminho).size > limiteBytes) {
      recusadas.push(alvo!)
      linhas.push(linha)
      continue
    }
    imagens.push({ bytes: readFileSync(caminho), mediaType: tipo, nome: basename(caminho), legenda: legenda || undefined })
  }
  return { texto: linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim(), imagens, recusadas }
}
