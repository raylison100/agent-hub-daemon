import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  gitPluginDir,
  PluginsFileSchema,
  type PluginBundle,
  type PluginDoClaudeCode,
  type PluginEntry,
  type PluginResumo,
  type RequisitoDePlugin,
} from '@agent-hub/core'

interface Manifesto {
  name?: string
  version?: string
  description?: string
  userConfig?: Record<string, { title?: string; description?: string; required?: boolean }>
}

const ferramentasDoPapel = ['list_dir', 'read_file', 'search', 'edit_file', 'write_file', 'run_command', 'memory_read']

function arquivoDePlugins(agentsDir: string): string {
  return join(agentsDir, 'plugins.json')
}

/** Le as entradas do plugins.json, vazio quando o arquivo nao existe. */
export function lerEntradas(agentsDir: string): PluginEntry[] {
  const arquivo = arquivoDePlugins(agentsDir)
  if (!existsSync(arquivo)) return []
  return PluginsFileSchema.parse(JSON.parse(readFileSync(arquivo, 'utf8'))).plugins
}

function gravarEntradas(agentsDir: string, entradas: PluginEntry[]): void {
  const limpas = entradas.map((e) => ({ ...(e.path ? { path: e.path } : { git: e.git, ...(e.ref ? { ref: e.ref } : {}) }), ...(e.enabled ? {} : { enabled: false }) }))
  writeFileSync(arquivoDePlugins(agentsDir), `${JSON.stringify({ plugins: limpas }, null, 2)}\n`)
}

/** Identificador estavel de uma entrada: o caminho absoluto ou a URL git. */
export function chaveDaEntrada(agentsDir: string, entrada: PluginEntry): string {
  return entrada.git ?? resolve(agentsDir, entrada.path!)
}

function pastaDaEntrada(agentsDir: string, entrada: PluginEntry): string {
  return entrada.git ? gitPluginDir(agentsDir, entrada.git) : resolve(agentsDir, entrada.path!)
}

/** Le o manifesto .claude-plugin/plugin.json de uma pasta, quando existe. */
export function lerManifesto(dir: string): Manifesto | null {
  const arquivo = join(dir, '.claude-plugin', 'plugin.json')
  if (!existsSync(arquivo)) return null
  try {
    return JSON.parse(readFileSync(arquivo, 'utf8')) as Manifesto
  } catch {
    return null
  }
}

/** Campos de configuracao que o plugin pede e se a chave correspondente ja esta no ambiente do daemon. */
export function requisitosDoPlugin(dir: string, env: NodeJS.ProcessEnv = process.env): RequisitoDePlugin[] {
  const campos = lerManifesto(dir)?.userConfig ?? {}
  return Object.entries(campos).map(([campo, c]) => {
    const variavel = campo.toUpperCase()
    return { campo, variavel, titulo: c.title ?? campo, descricao: c.description ?? '', obrigatorio: Boolean(c.required), definida: Boolean(env[variavel]) }
  })
}

/** Junta as entradas do plugins.json com o que foi carregado de cada uma. */
export function resumirPlugins(agentsDir: string, carregados: PluginBundle[], papeis: Map<string, string[]>, env: NodeJS.ProcessEnv = process.env): PluginResumo[] {
  return lerEntradas(agentsDir).map((entrada) => {
    const dir = pastaDaEntrada(agentsDir, entrada)
    const bundle = entrada.enabled ? carregados.find((p) => resolve(p.dir) === resolve(dir)) : undefined
    const manifesto = lerManifesto(dir)
    const name = bundle?.name ?? manifesto?.name ?? basename(dir)
    const papel = [...papeis].find(([nome, skills]) => nome === name || skills.some((s) => s.startsWith(`${name}:`)))?.[0] ?? null
    return {
      chave: chaveDaEntrada(agentsDir, entrada),
      name,
      dir,
      enabled: entrada.enabled,
      descricao: manifesto?.description ?? '',
      versao: manifesto?.version ?? null,
      skills: bundle?.skills.size ?? 0,
      agents: bundle?.profiles.size ?? 0,
      mcp: bundle ? Object.keys(bundle.mcp).length : 0,
      hooks: bundle?.hooks.length ?? 0,
      nomes_skills: bundle ? [...bundle.skills.keys()].sort() : [],
      nomes_mcp: bundle ? Object.keys(bundle.mcp).sort() : [],
      requisitos: existsSync(dir) ? requisitosDoPlugin(dir, env) : [],
      erros: bundle?.errors.map((e) => e.message) ?? (existsSync(dir) || !entrada.enabled ? [] : [entrada.git ? 'repositorio ainda nao clonado' : 'pasta nao encontrada']),
      papel,
    }
  })
}

/** Lista os plugins instalados no Claude Code, preferindo a pasta de origem do marketplace local a copia em cache. */
export function pluginsDoClaudeCode(agentsDir: string, claudeHome = join(homedir(), '.claude')): PluginDoClaudeCode[] {
  const instalados = join(claudeHome, 'plugins', 'installed_plugins.json')
  if (!existsSync(instalados)) return []
  const dados = JSON.parse(readFileSync(instalados, 'utf8')) as { plugins?: Record<string, { installPath?: string; version?: string }[]> }
  const marketplacesArquivo = join(claudeHome, 'plugins', 'known_marketplaces.json')
  const marketplaces = existsSync(marketplacesArquivo)
    ? (JSON.parse(readFileSync(marketplacesArquivo, 'utf8')) as Record<string, { source?: { source?: string; path?: string }; installLocation?: string }>)
    : {}
  const adicionadas = new Set(lerEntradas(agentsDir).map((e) => resolve(pastaDaEntrada(agentsDir, e))))
  const out: PluginDoClaudeCode[] = []
  for (const [id, versoes] of Object.entries(dados.plugins ?? {})) {
    const [nome = id, marketplace = ''] = id.split('@')
    const instalado = versoes[versoes.length - 1]
    const origem = marketplaces[marketplace]
    const candidatos = [
      origem?.source?.source === 'directory' && origem.source.path ? join(origem.source.path, 'plugins', nome) : '',
      origem?.installLocation ? join(origem.installLocation, 'plugins', nome) : '',
      instalado?.installPath ?? '',
    ].filter(Boolean)
    const pasta = candidatos.find((c) => lerManifesto(c) !== null) ?? candidatos.find((c) => existsSync(c))
    if (!pasta) continue
    const manifesto = lerManifesto(pasta)
    out.push({
      id,
      nome: manifesto?.name ?? nome,
      versao: manifesto?.version ?? instalado?.version ?? '',
      descricao: manifesto?.description ?? '',
      pasta,
      ja_adicionado: adicionadas.has(resolve(pasta)),
    })
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome))
}

/** Acrescenta um plugin por pasta local ou repositorio git ao plugins.json. */
export function adicionarPlugin(agentsDir: string, pedido: { path?: string; git?: string; ref?: string }): PluginEntry {
  const path = pedido.path?.trim()
  const git = pedido.git?.trim()
  if (Boolean(path) === Boolean(git)) throw new Error('informe a pasta do plugin ou a URL git, uma das duas')
  const entradas = lerEntradas(agentsDir)
  let entrada: PluginEntry
  if (path) {
    const dir = resolve(path)
    if (!existsSync(dir)) throw new Error(`pasta nao encontrada: ${dir}`)
    if (!lerManifesto(dir) && !existsSync(join(dir, 'skills')) && !existsSync(join(dir, '.mcp.json'))) {
      throw new Error(`${dir} nao parece um plugin do Claude Code: falta .claude-plugin/plugin.json, skills/ ou .mcp.json`)
    }
    entrada = { path: dir, enabled: true }
  } else {
    if (!/^(https:\/\/|git@|ssh:\/\/)/.test(git!)) throw new Error('URL git precisa comecar com https://, ssh:// ou git@')
    entrada = { git: git!, ref: pedido.ref?.trim() || undefined, enabled: true }
  }
  const chave = chaveDaEntrada(agentsDir, entrada)
  if (entradas.some((e) => chaveDaEntrada(agentsDir, e) === chave)) throw new Error('esse plugin ja esta na lista')
  gravarEntradas(agentsDir, [...entradas, entrada])
  return entrada
}

/** Tira um plugin do plugins.json; a pasta dele continua onde estava. */
export function removerPlugin(agentsDir: string, chave: string): void {
  const entradas = lerEntradas(agentsDir)
  const restantes = entradas.filter((e) => chaveDaEntrada(agentsDir, e) !== chave)
  if (restantes.length === entradas.length) throw new Error('plugin nao encontrado na lista')
  gravarEntradas(agentsDir, restantes)
}

/** Liga ou desliga um plugin sem tira-lo da lista. */
export function alternarPlugin(agentsDir: string, chave: string, enabled: boolean): void {
  const entradas = lerEntradas(agentsDir)
  const alvo = entradas.find((e) => chaveDaEntrada(agentsDir, e) === chave)
  if (!alvo) throw new Error('plugin nao encontrado na lista')
  alvo.enabled = enabled
  gravarEntradas(agentsDir, entradas)
}

/** Grava um papel com as skills, os servidores MCP e as ferramentas de escrita do plugin. */
export function criarPapelDoPlugin(agentsDir: string, plugin: PluginBundle, modelos: string[]): string {
  if (modelos.length === 0) throw new Error('escolha ao menos um modelo para o papel')
  if (plugin.skills.size === 0 && Object.keys(plugin.mcp).length === 0) throw new Error(`o plugin ${plugin.name} nao tem skills nem servidores MCP para um papel`)
  const dir = join(agentsDir, 'roles')
  mkdirSync(dir, { recursive: true })
  const arquivo = join(dir, `${plugin.name}.md`)
  if (existsSync(arquivo)) throw new Error(`ja existe o papel ${plugin.name} em ${arquivo}`)
  const skills = [...plugin.skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  const descricao = (lerManifesto(plugin.dir)?.description ?? `Usa as skills do plugin ${plugin.name}`).replace(/\s+/g, ' ').slice(0, 160)
  const texto = [
    '---',
    `name: ${plugin.name}`,
    `description: ${JSON.stringify(descricao)}`,
    `models: [${modelos.join(', ')}]`,
    'tools:',
    `  native: [${ferramentasDoPapel.join(', ')}]`,
    `  mcp: [${Object.keys(plugin.mcp).sort().join(', ')}]`,
    `skills: [${skills.map((s) => s.name).join(', ')}]`,
    'policy: padrao',
    'max_steps: 60',
    '---',
    '',
    `Voce trabalha com as skills do plugin ${plugin.name}.`,
    '',
    'Como trabalhar:',
    '',
    '- Antes de comecar, carregue com load_skill a skill que a tarefa pede:',
    ...skills.map((s) => `  - ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 200)}`),
    '- Siga o fluxo da skill na ordem. Os arquivos dela ficam na pasta que o',
    '  load_skill informa: leia pelo caminho absoluto.',
    '- O que voce criar vai no workspace.',
    '- Quando faltar informacao que so o usuario tem, pergunte uma vez, de forma',
    '  objetiva.',
    '- Nunca use emojis. Responda em portugues, curto e direto.',
    '',
    'Ao terminar, liste os arquivos gerados.',
    '',
  ].join('\n')
  writeFileSync(arquivo, texto)
  return arquivo
}
