#!/usr/bin/env node
import { Command } from 'commander'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { ReportGroup, RunEvent } from '@agent-hub/core'
import type { PendingApproval } from './approvals.js'
import { ensureToken, exampleConfig, loadConfig } from './config.js'
import { Runtime } from './runtime.js'
import { startServer } from './server.js'

const program = new Command()
program.name('agent-hub-daemon').description('Servico local do Agent Hub').version('0.1.0')

program
  .command('init')
  .description('Cria config.toml de exemplo em ~/.agent-hub')
  .action(() => {
    const config = loadConfig()
    const file = join(config.home, 'config.toml')
    if (existsSync(file)) {
      console.log(`ja existe: ${file}`)
      return
    }
    writeFileSync(file, exampleConfig())
    console.log(`criado: ${file}. Edite agents_dir e workspaces antes de iniciar.`)
  })

program
  .command('start')
  .description('Inicia o servidor WebSocket local')
  .action(async () => {
    const config = loadConfig()
    const runtime = new Runtime(config)
    reportErrors(runtime)
    const token = ensureToken(config.home)
    const server = await startServer(runtime, token)
    console.log(`daemon em ws://${config.host}:${config.port}/ws (dispositivo ${config.deviceName})`)
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
  .description('Mostra o token local para conectar um cliente')
  .action(() => {
    const config = loadConfig()
    console.log(`url: ws://${config.host}:${config.port}/ws`)
    console.log(`token: ${ensureToken(config.home)}`)
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
  .requiredOption('-a, --agent <name>', 'perfil do agente')
  .requiredOption('-w, --workspace <dir>', 'diretorio permitido')
  .option('-s, --session <id>', 'continuar sessao existente')
  .action(async (opts: { agent: string; workspace: string; session?: string }) => {
    const runtime = new Runtime(loadConfig())
    reportErrors(runtime)
    const workspace = runtime.assertWorkspace(opts.workspace)
    const session = opts.session ? runtime.store.get(opts.session) : runtime.store.create(opts.agent, workspace)
    if (!session) throw new Error('sessao nao encontrada')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log(`sessao ${session.id} com ${session.agent} em ${session.workspace}. Linha vazia encerra.`)
    for (;;) {
      const text = (await rl.question('\nvoce> ')).trim()
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
