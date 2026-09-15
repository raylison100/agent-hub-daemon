import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServerSchema, type ConectorEditavel, type LimitesDeGasto, type McpServerConfig, type PrecoDeModelo, type PricingTable, type VariavelDoConector } from '@agent-hub/core'
import { readServers } from './connectors.js'

const referencia = /^\$\{([A-Z][A-Z0-9_]*)\}$/
const referencias = /\$\{([A-Z][A-Z0-9_]*)\}/g

const testesDeProvedor: Record<string, (chave: string) => { url: string; headers: Record<string, string> }> = {
  ANTHROPIC_API_KEY: (chave) => ({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01' } }),
  OPENAI_API_KEY: (chave) => ({ url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${chave}` } }),
  DEEPSEEK_API_KEY: (chave) => ({ url: 'https://api.deepseek.com/models', headers: { authorization: `Bearer ${chave}` } }),
  GEMINI_API_KEY: (chave) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': chave } }),
}

/** Diz se existe teste automatico para a chave de um provedor de modelo. */
export function chaveDeProvedorTestavel(nome: string): boolean {
  return nome in testesDeProvedor
}

/** Confere a chave de um provedor listando os modelos, sem gastar tokens. */
export async function testarChaveDeProvedor(nome: string, valor: string): Promise<{ ok: boolean; mensagem: string }> {
  const montar = testesDeProvedor[nome]
  if (!montar) return { ok: false, mensagem: 'não há teste automático para essa chave' }
  const { url, headers } = montar(valor)
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    if (res.ok) return { ok: true, mensagem: 'a empresa aceitou a chave' }
    if (res.status === 401 || res.status === 403) return { ok: false, mensagem: 'a empresa recusou a chave: confira se foi copiada inteira e se ainda está ativa' }
    if (res.status === 429) return { ok: true, mensagem: 'a chave é válida, mas a conta está no limite de uso agora' }
    return { ok: false, mensagem: `a empresa respondeu com erro ${res.status}` }
  } catch {
    return { ok: false, mensagem: 'não consegui falar com a empresa: confira a internet desta máquina' }
  }
}

/** Nomes de variavel citados em `${NOME}` dentro de um conector. */
export function chavesDoConector(server: McpServerConfig): string[] {
  const textos = [server.command ?? '', server.url ?? '', ...server.args, ...Object.values(server.env), ...Object.values(server.headers)]
  return [...new Set(textos.flatMap((t) => [...t.matchAll(referencias)].map((m) => m[1]!)))]
}

function lerJson<T>(arquivo: string, padrao: T): T {
  if (!existsSync(arquivo)) return padrao
  return JSON.parse(readFileSync(arquivo, 'utf8')) as T
}

/** Grava os limites de gasto em policies/budgets.json, mantendo agentes que nao vieram na tela. */
export function salvarLimites(agentsDir: string, limites: LimitesDeGasto): void {
  const arquivo = join(agentsDir, 'policies', 'budgets.json')
  const atual = lerJson<{ agents?: Record<string, Record<string, unknown>> } & Record<string, unknown>>(arquivo, {})
  const valido = (v: number | null): number | undefined => {
    if (v === null) return undefined
    if (!Number.isFinite(v) || v < 0) throw new Error('limite de gasto precisa ser um número maior ou igual a zero')
    return v
  }
  const agents: Record<string, Record<string, unknown>> = { ...(atual.agents ?? {}) }
  for (const [nome, dia] of Object.entries(limites.agents)) {
    const resto = { ...(agents[nome] ?? {}) }
    const v = valido(dia)
    if (v === undefined) delete resto.day_usd
    else resto.day_usd = v
    if (Object.keys(resto).length) agents[nome] = resto
    else delete agents[nome]
  }
  const saida: Record<string, unknown> = { ...atual, agents }
  for (const campo of ['global_month_usd', 'automation_month_usd'] as const) {
    const v = valido(limites[campo])
    if (v === undefined) delete saida[campo]
    else saida[campo] = v
  }
  writeFileSync(arquivo, `${JSON.stringify(saida, null, 2)}\n`)
}

/** Tabela de precos em formato de lista para a tela. */
export function lerPrecos(agentsDir: string): { versao: string; modelos: PrecoDeModelo[] } {
  const tabela = lerJson<PricingTable>(join(agentsDir, 'pricing.json'), { version: '', models: {} })
  const modelos = Object.entries(tabela.models)
    .map(([chave, p]) => ({ chave, input: p.input ?? null, output: p.output ?? null, cache_read: p.cache_read ?? null, cache_write: p.cache_write ?? null }))
    .sort((a, b) => a.chave.localeCompare(b.chave))
  return { versao: tabela.version, modelos }
}

/** Grava os precos editados, mantendo notas, descontos e campos extras de cada modelo, e marca a tabela com a data de hoje. */
export function salvarPrecos(agentsDir: string, modelos: PrecoDeModelo[], hoje: Date = new Date()): void {
  const arquivo = join(agentsDir, 'pricing.json')
  const tabela = lerJson<PricingTable & Record<string, unknown>>(arquivo, { version: '', models: {} })
  const models: PricingTable['models'] = {}
  for (const m of modelos) {
    const chave = m.chave.trim()
    if (!/^[a-z0-9-]+\/[^\s]+$/.test(chave)) throw new Error(`modelo inválido: "${chave}" (use empresa/modelo, como openai/gpt-5.6-sol)`)
    if (models[chave]) throw new Error(`modelo repetido: ${chave}`)
    for (const campo of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const v = m[campo]
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`preço inválido em ${chave}`)
    }
    const anterior = tabela.models[chave] ?? {}
    const novo: PricingTable['models'][string] = { ...anterior, input: m.input, output: m.output }
    if (m.cache_read === null) delete novo.cache_read
    else novo.cache_read = m.cache_read
    if (m.cache_write === null) delete novo.cache_write
    else novo.cache_write = m.cache_write
    models[chave] = novo
  }
  const version = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`
  writeFileSync(arquivo, `${JSON.stringify({ ...tabela, version, models }, null, 2)}\n`)
}

function nomeDaVariavel(servidor: string, campo: string): string {
  return `${servidor}_${campo}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function paraLista(valores: Record<string, string>, definida: (nome: string) => boolean): VariavelDoConector[] {
  return Object.entries(valores).map(([nome, valor]) => {
    const ref = referencia.exec(valor)
    return ref ? { nome, valor: '', chave: ref[1]!, definida: definida(ref[1]!) } : { nome, valor, chave: null }
  })
}

/** Conector do mcp.json no formato do formulario, sem revelar valores guardados como chave. */
export function detalheDoConector(agentsDir: string, nome: string, definida: (nome: string) => boolean): ConectorEditavel {
  const server = readServers(agentsDir)[nome]
  if (!server) throw new Error(`conector não encontrado: ${nome}`)
  return {
    name: nome,
    transporte: server.url ? 'http' : 'stdio',
    command: server.command ?? '',
    args: server.args,
    url: server.url ?? '',
    env: paraLista(server.env, definida),
    headers: paraLista(server.headers, definida),
    enabled: server.enabled,
  }
}

/** Grava um conector vindo do formulario; valores marcados como chave vao para o cofre e o arquivo guarda so a referencia. */
export function salvarConector(
  agentsDir: string,
  conector: ConectorEditavel,
  original: string | undefined,
  guardarChave: (nome: string, valor: string) => void,
): { nome: string; chavesFaltando: string[] } {
  const nome = conector.name.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(nome)) throw new Error('nome do conector: use letras, números, hífen, ponto ou sublinhado, sem espaços')
  const servers = readServers(agentsDir)
  if (original && !servers[original]) throw new Error(`conector não encontrado: ${original}`)
  if (original && original !== nome) throw new Error('o nome de um conector existente não pode ser trocado')
  if (!original && servers[nome]) throw new Error(`já existe um conector chamado ${nome}`)
  const anterior = original ? servers[original] : undefined
  const faltando: string[] = []
  const montar = (lista: VariavelDoConector[], tipo: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const item of lista) {
      const campo = item.nome.trim()
      if (!campo) continue
      if (out[campo] !== undefined) throw new Error(`${tipo} repetida: ${campo}`)
      if (item.chave === null) {
        out[campo] = item.valor
        continue
      }
      const variavel = item.chave.trim() || nomeDaVariavel(nome, campo)
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(variavel)) throw new Error(`nome de chave inválido: ${variavel}`)
      if (item.valor.trim()) guardarChave(variavel, item.valor)
      else if (!item.definida) faltando.push(variavel)
      out[campo] = `\${${variavel}}`
    }
    return out
  }
  const base = {
    args: conector.args.map((a) => a.trim()).filter(Boolean),
    env: montar(conector.env, 'variável'),
    headers: montar(conector.headers, 'cabeçalho'),
    risk: anterior?.risk ?? { read_: 'read', list_: 'read', get_: 'read', search_: 'read', '*': 'write' },
    enabled: conector.enabled,
    ...(anterior?.oauth ? { oauth: anterior.oauth } : {}),
  }
  if (conector.transporte === 'http' && !conector.url.trim()) throw new Error('informe o endereço (URL) do conector')
  if (conector.transporte === 'stdio' && !conector.command.trim()) throw new Error('informe o comando que inicia o conector')
  const bruto = conector.transporte === 'http' ? { ...base, url: conector.url.trim() } : { ...base, command: conector.command.trim() }
  const validado = McpServerSchema.safeParse(bruto)
  if (!validado.success) throw new Error(validado.error.issues.map((i) => (i.path.join('.') === 'url' ? 'endereço (URL) inválido' : i.message)).join('; '))
  servers[nome] = validado.data
  writeFileSync(join(agentsDir, 'mcp.json'), `${JSON.stringify({ servers }, null, 2)}\n`)
  return { nome, chavesFaltando: [...new Set(faltando)] }
}
