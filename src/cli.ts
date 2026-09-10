#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { ReportGroup, RunEvent } from '@agent-hub/core'
import type { PendingApproval } from './approvals.js'
import { AutomationRunner } from './automation.js'
import { ensureAccountToken, ensureDeviceId, ensureToken, envTemplate, exampleConfig, loadConfig } from './config.js'
import { serveMcp } from './mcp-server.js'
import { Runtime } from './runtime.js'
import { Scheduler } from './schedules.js'
import { startServer } from './server.js'

const program = new Command()
program.name('agent-hub-daemon').description('Servico local do Agent Hub').version('0.1.0')

program
  .command('init')
  .description('Cria config.toml de exemplo em ~/.agent-hub')
  .action(() => {
    const config = loadConfig()
    const file = join(config.home, 'config.toml')
    if (existsSync(file)) console.log(`ja existe: ${file}`)
    else {
      writeFileSync(file, exampleConfig())
      console.log(`criado: ${file}. Edite agents_dir e workspaces antes de iniciar.`)
    }
    const envFile = join(config.home, '.env')
    if (existsSync(envFile)) console.log(`ja existe: ${envFile}`)
    else {
      writeFileSync(envFile, envTemplate, { mode: 0o600 })
      console.log(`criado: ${envFile}. Preencha as chaves de API.`)
    }
  })

program
  .command('env')
  .description('Mostra quais chaves o daemon encontra, sem revelar valores')
  .action(() => {
    const config = loadConfig()
    for (const name of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY']) {
      const v = process.env[name]
      console.log(`${name}\t${v ? `definida (${v.length} caracteres, termina em ${v.slice(-4)})` : 'ausente'}`)
    }
    console.log(`arquivo: ${join(config.home, '.env')} ${existsSync(join(config.home, '.env')) ? 'existe' : 'ausente'}`)
  })

program
  .command('start')
  .description('Inicia o servidor WebSocket local')
  .action(async () => {
    const config = loadConfig()
    const runtime = new Runtime(config)
    reportErrors(runtime)
    const token = ensureToken(config.home)
    const relay = config.relayUrl ? { accountToken: ensureAccountToken(config.home), deviceId: ensureDeviceId(config.home) } : undefined
    const server = await startServer(runtime, token, relay)
    console.log(`daemon em ws://${config.host}:${config.port}/ws (dispositivo ${config.deviceName})`)
    if (config.relayUrl) console.log(`relay configurado: ${config.relayUrl}`)
    console.log(`agentes: ${runtime.agents().map((a) => a.name).join(', ') || 'nenhum'}`)
    const stop = async () => {
      await server.close()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })

program
  .command('status')
  .description('Verifica se o daemon responde')
  .action(async () => {
    const config = loadConfig()
    try {
      const res = await fetch(`http://${config.host}:${config.port}/health`)
      console.log(await res.text())
    } catch {
      console.log('daemon nao esta respondendo')
      process.exitCode = 1
    }
  })

program
  .command('pair')
  .description('Mostra os dados para conectar um cliente, local ou pelo relay, com link e QR de emparelhamento')
  .option('--web <url>', 'URL onde a interface web esta servida', 'http://localhost:5173')
  .option('--no-qr', 'nao desenhar o QR no terminal')
  .action(async (opts: { web: string; qr: boolean }) => {
    const config = loadConfig()
    const token = ensureToken(config.home)
    console.log(`url local: ws://${config.host}:${config.port}/ws`)
    console.log(`token do daemon: ${token}`)
    const pair: Record<string, string> = { mode: 'direct', url: `ws://${config.host}:${config.port}/ws`, token }
    if (config.relayUrl) {
      const account = ensureAccountToken(config.home)
      const device = ensureDeviceId(config.home)
      console.log(`relay: ${config.relayUrl}`)
      console.log(`token de conta: ${account}`)
      console.log(`dispositivo: ${device} (${config.deviceName})`)
      Object.assign(pair, { mode: 'relay', url: config.relayUrl, account, device })
    } else {
      console.log('relay: nao configurado (relay_url no config.toml)')
    }
    const link = `${opts.web.replace(/\/$/, '')}/connect#pair=${Buffer.from(JSON.stringify(pair)).toString('base64url')}`
    console.log(`\nlink de emparelhamento (contem segredos, nao compartilhe):\n${link}`)
    if (opts.qr) {
      const { toString } = await import('qrcode')
      console.log(await toString(link, { type: 'terminal', small: true }))
    }
  })

program
  .command('plugins')
  .description('Sincroniza plugins declarados por git em agents/plugins.json e lista os carregados')
  .argument('[acao]', 'sync para clonar ou atualizar', 'list')
  .action((acao: string) => {
    const runtime = new Runtime(loadConfig())
    if (acao === 'sync') runtime.syncGitPlugins((m) => console.log(m))
    for (const p of runtime.repo.plugins) {
      console.log(`${p.name}\t${p.dir}\tskills ${p.skills.size}\tagentes ${p.profiles.size}\tmcp ${Object.keys(p.mcp).length}\thooks ${p.hooks.length}`)
    }
    reportErrors(runtime)
  })

program
  .command('mcp')
  .description('Expoe o daemon como servidor MCP por stdio, para o Claude Code, o Claude Desktop ou outro cliente MCP')
  .option('--url <url>', 'URL do daemon ou do relay; padrao: daemon local do config')
  .option('--relay-account <token>', 'token de conta, quando pelo relay')
  .option('--device <id>', 'id do dispositivo, quando pelo relay')
  .option('--timeout <ms>', 'tempo maximo de um run', '900000')
  .action(async (opts: { url?: string; relayAccount?: string; device?: string; timeout: string }) => {
    const config = loadConfig()
    await serveMcp({
      url: opts.url ?? `ws://${config.host}:${config.port}/ws`,
      token: ensureToken(config.home),
      accountToken: opts.relayAccount,
      deviceId: opts.device,
      runTimeoutMs: Number(opts.timeout),
    })
  })

program
  .command('workflows')
  .description('Lista workflows declarativos com custo maximo, ou roda um deles')
  .argument('[nome]', 'nome do workflow para rodar')
  .option('-w, --workspace <dir>', 'workspace do run')
  .option('-i, --input <k=v...>', 'entradas do workflow')
  .action(async (nome: string | undefined, opts: { workspace?: string; input?: string[] }) => {
    const runtime = new Runtime(loadConfig())
    reportErrors(runtime)
    const { WorkflowEngine } = await import('./workflows.js')
    const engine = new WorkflowEngine(runtime, (f) => {
      if (f.type === 'workflow.step') console.log(`[${f.step}] ${f.status}${f.detail ? ` ${f.detail}` : ''}${f.cost_usd !== undefined ? ` ${f.cost_usd.toFixed(4)} USD` : ''}`)
      if (f.type === 'event') printEvent(f.event)
      if (f.type === 'approval.required') void askInTerminalPlain(runtime, f.approval_id, f.tool, f.args)
    })
    if (!nome) {
      for (const w of engine.list()) {
        console.log(`${w.name}\t${w.mode}\tentradas ${w.inputs.join(',') || '-'}\tcusto maximo ${w.maxCostUsd === null ? 'indefinido' : w.maxCostUsd.toFixed(4)} USD\t${w.description}`)
      }
      return
    }
    if (!opts.workspace) throw new Error('informe --workspace')
    const inputs: Record<string, string> = {}
    for (const pair of opts.input ?? []) {
      const i = pair.indexOf('=')
      if (i > 0) inputs[pair.slice(0, i)] = pair.slice(i + 1)
    }
    const outcome = await engine.run({ name: nome, inputs, workspace: opts.workspace })
    console.log(`\n[${outcome.status}] custo ${outcome.costUsd.toFixed(4)} USD${outcome.error ? `: ${outcome.error}` : ''}`)
    await runtime.mcp.close()
  })

program
  .command('triggers')
  .description('Lista gatilhos externos cadastrados')
  .action(() => {
    const runtime = new Runtime(loadConfig())
    const rows = runtime.db.prepare('SELECT id, spec_json, source, last_fired_at FROM triggers ORDER BY id').all() as {
      id: string
      spec_json: string
      source: string
      last_fired_at: number | null
    }[]
    if (rows.length === 0) console.log('nenhum gatilho')
    for (const r of rows) {
      const spec = JSON.parse(r.spec_json) as { source: string; agent: string; mode: string; enabled: boolean }
      const last = r.last_fired_at ? new Date(r.last_fired_at).toISOString() : 'nunca'
      console.log(`${r.id}\t${spec.enabled ? 'on' : 'off'}\t${spec.source}\t${spec.agent}\t${spec.mode}\t${r.source}\tultimo ${last}`)
    }
  })

program
  .command('agents')
  .description('Lista perfis carregados e erros de carregamento')
  .action(() => {
    const runtime = new Runtime(loadConfig())
    for (const a of runtime.agents()) console.log(`${a.name}\t${a.provider}/${a.model}\t${a.reasoning}\t${a.description}`)
    reportErrors(runtime)
  })

program
  .command('schedules')
  .description('Lista agendamentos e o estado do interruptor geral')
  .action(() => {
    const runtime = new Runtime(loadConfig())
    const automation = new AutomationRunner(runtime, runtime.db, () => undefined)
    const scheduler = new Scheduler(runtime, runtime.db, automation, () => undefined)
    console.log(`automacao ${scheduler.paused ? 'pausada' : 'ativa'}`)
    for (const s of scheduler.list()) {
      const next = s.nextRunAt ? new Date(s.nextRunAt).toISOString() : 'nunca'
      console.log(`${s.id}\t${s.enabled ? 'on' : 'off'}\t${s.cron ?? `at ${s.at}`}\t${s.agent}\t${s.mode}\tproximo ${next}\thoje ${s.todayUsd.toFixed(4)} USD`)
    }
  })

program
  .command('cost')
  .description('Relatorio de custo do ledger')
  .option('-g, --group <group>', 'agent | model | session | day', 'agent')
  .option('-s, --since <period>', 'today | week | month | all', 'month')
  .action((opts: { group: string; since: string }) => {
    const runtime = new Runtime(loadConfig())
    const rows = runtime.ledger.report(opts.group as ReportGroup, { since: sinceOf(opts.since) })
    if (rows.length === 0) {
      console.log('sem registros no periodo')
      return
    }
    console.log(['chave', 'usd', 'chamadas', 'input', 'output', 'cache_read'].join('\t'))
    for (const r of rows) console.log([r.key, r.costUsd.toFixed(4), r.calls, r.input, r.output, r.cacheRead].join('\t'))
    const total = runtime.ledger.totals({ since: sinceOf(opts.since) })
    console.log(`total\t${total.costUsd.toFixed(4)}\t${total.calls}`)
  })

program
  .command('chat')
  .description('Conversa interativa com um agente, aprovando ferramentas pelo terminal')
  .option('-a, --agent <name>', 'perfil do agente; sem ele, o roteamento por regra decide pela primeira mensagem')
  .requiredOption('-w, --workspace <dir>', 'diretorio permitido')
  .option('-s, --session <id>', 'continuar sessao existente')
  .action(async (opts: { agent?: string; workspace: string; session?: string }) => {
    const runtime = new Runtime(loadConfig())
    reportErrors(runtime)
    const workspace = runtime.assertWorkspace(opts.workspace)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    let session = opts.session ? runtime.store.get(opts.session) : undefined
    if (opts.session && !session) throw new Error('sessao nao encontrada')
    let pending: string | undefined
    if (!session) {
      if (!opts.agent) pending = (await rl.question('\nvoce> ')).trim()
      const { agent, routed } = await runtime.resolveAgent(opts.agent, pending ?? '', workspace)
      if (routed) console.log(`[roteamento] intencao ${routed.intent ?? 'nenhuma'} escolheu ${agent}`)
      session = runtime.store.create(agent, workspace)
    }
    console.log(`sessao ${session.id} com ${session.agent} em ${session.workspace}. Linha vazia encerra.`)
    for (;;) {
      const text = pending ?? (await rl.question('\nvoce> ')).trim()
      pending = undefined
      if (text === '') break
      const result = await runtime.run({
        sessionId: session.id,
        text,
        emit: printEvent,
        onApproval: (info) => void askInTerminal(runtime, rl, info),
      })
      console.log(`\n[${result.stop}] passos ${result.steps}, custo ${result.costUsd.toFixed(4)} USD`)
    }
    rl.close()
    await runtime.mcp.close()
  })

function printEvent(e: RunEvent): void {
  switch (e.type) {
    case 'text_delta':
      process.stdout.write(e.delta)
      return
    case 'tool_call':
      console.log(`\n[ferramenta ${e.call.name} ${e.decision}] ${JSON.stringify(e.call.args)}`)
      return
    case 'tool_result':
      console.log(`[resultado ${e.name}${e.isError ? ' erro' : ''} ${e.ms}ms] ${e.content.slice(0, 300).replace(/\n/g, ' ')}`)
      return
    case 'usage':
      console.log(
        `\n[passo ${e.step} ${e.model}] in ${e.usage.input} cache ${e.usage.cacheRead} out ${e.usage.output} custo ${e.costUsd.toFixed(5)} USD`,
      )
      return
    case 'budget_warning':
      console.log(`\n[aviso orcamento ${e.warning.scope}] ${e.warning.spentUsd.toFixed(4)} de ${e.warning.limitUsd.toFixed(4)} USD`)
      return
    case 'escalation':
      console.log(`\n[escalada] ${e.from} para ${e.to}: ${e.reason}`)
      return
    case 'compaction':
      console.log(`\n[compactacao ${e.mode}] ${e.before} para ${e.after} tokens estimados`)
      return
    case 'skills_loaded':
      console.log(`\n[skills] ${e.names.join(', ')}`)
      return
    case 'delegation':
      console.log(e.phase === 'start' ? `\n[delegando a ${e.agent}] ${e.task.slice(0, 120)}` : `\n[${e.agent} terminou] ${e.stop}, ${(e.costUsd ?? 0).toFixed(4)} USD`)
      return
    case 'hook':
      console.log(`\n[hook ${e.event}${e.tool ? ` ${e.tool}` : ''}] ${e.allow ? 'permitiu' : `negou: ${e.reason ?? ''}`}`)
      return
    case 'phase':
      console.log(`\n[fase ${e.index + 1}: ${e.name}] ferramentas: ${e.tools.join(', ')}`)
      return
    case 'run_finished':
      if (e.error) console.log(`\n[erro] ${e.error}`)
      return
    default:
      return
  }
}

async function askInTerminal(runtime: Runtime, rl: ReturnType<typeof createInterface>, info: PendingApproval): Promise<void> {
  const answer = (await rl.question(`\naprovar ${info.tool} ${JSON.stringify(info.args)}? [s/N] `)).trim().toLowerCase()
  runtime.approvals.respond(info.id, answer === 's' ? 'allow' : 'deny')
}

async function askInTerminalPlain(runtime: Runtime, id: string, tool: string, args: unknown): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`\naprovar ${tool} ${JSON.stringify(args)}? [s/N] `)).trim().toLowerCase()
  rl.close()
  runtime.approvals.respond(id, answer === 's' ? 'allow' : 'deny')
}

function reportErrors(runtime: Runtime): void {
  for (const e of runtime.repo.errors) console.error(`erro em ${e.file}: ${e.message}`)
}

function sinceOf(period: string): number | undefined {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (period === 'today') return d.getTime()
  if (period === 'week') return d.getTime() - 6 * 24 * 60 * 60 * 1000
  if (period === 'month') {
    d.setDate(1)
    return d.getTime()
  }
  return undefined
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
