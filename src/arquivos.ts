import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { resolveInside } from '@agent-hub/core'
import type { FastifyInstance } from 'fastify'
import type { Runtime } from './runtime.js'

const tipos: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

export const extensoesVisualizaveis = ['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']

/** Tipo de conteudo de um arquivo que o painel pode mostrar, ou undefined quando a extensao nao e servida. */
export function tipoDoArquivo(caminho: string): string | undefined {
  return tipos[extname(caminho).toLowerCase()]
}

const limiteDeLeitura = 20 * 1024 * 1024

/** Le um arquivo visualizavel do workspace da sessao, para o painel receber pelo proprio canal do protocolo. */
export function lerArquivoDaSessao(runtime: Runtime, sessionId: string, relativo: string): { mediaType: string; data: string; size: number } {
  const sessao = runtime.store.get(sessionId)
  if (!sessao) throw new Error('sessao nao encontrada')
  const tipo = tipoDoArquivo(relativo)
  if (!tipo || !extensoesVisualizaveis.includes(extname(relativo).toLowerCase())) throw new Error('tipo de arquivo nao visualizavel')
  const arquivo = resolveInside(sessao.workspace, relativo)
  if (!existsSync(arquivo) || !statSync(arquivo).isFile()) throw new Error(`arquivo nao encontrado: ${relativo}`)
  const size = statSync(arquivo).size
  if (size > limiteDeLeitura) throw new Error(`arquivo grande demais para o painel (${Math.round(size / 1024 / 1024)} MB); use Abrir fora`)
  return { mediaType: tipo, data: readFileSync(arquivo).toString('base64'), size }
}

/** Serve arquivos do workspace de uma sessao para o painel de visualizacao, so para a propria maquina e com HTML isolado da origem do daemon. */
export function registrarRotaDeArquivos(app: FastifyInstance, runtime: Runtime, isLoopback: (ip: string) => boolean): void {
  app.get('/arquivos/:sessao/*', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: 'so a propria maquina visualiza arquivos' })
    const { sessao, '*': bruto } = req.params as { sessao: string; '*': string }
    const sessaoInfo = /^[0-9a-f-]{36}$/.test(sessao) ? runtime.store.get(sessao) : undefined
    if (!sessaoInfo) return reply.code(404).send({ error: 'sessao nao encontrada' })
    const relativo = decodeURIComponent(bruto ?? '')
    const tipo = tipoDoArquivo(relativo)
    if (!tipo) return reply.code(415).send({ error: 'tipo de arquivo nao visualizavel' })
    let arquivo: string
    try {
      arquivo = resolveInside(sessaoInfo.workspace, relativo)
    } catch {
      return reply.code(403).send({ error: 'arquivo fora do workspace da sessao' })
    }
    if (!existsSync(arquivo) || !statSync(arquivo).isFile()) return reply.code(404).send({ error: 'arquivo nao encontrado' })
    reply
      .type(tipo)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
    if (/html|svg|javascript/.test(tipo)) reply.header('content-security-policy', 'sandbox allow-scripts allow-downloads allow-popups allow-modals allow-forms')
    return reply.send(createReadStream(arquivo))
  })
}
