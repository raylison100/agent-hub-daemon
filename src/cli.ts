#!/usr/bin/env node
import { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { approxTokens, classifyIntent, needsDelegation, route } from '@agent-hub/core'
import type { ReportGroup, RunEvent } from '@agent-hub/core'
import type { PendingApproval } from './approvals.js'
import { AutomationRunner } from './automation.js'
import { configHome, ensureAccountToken, ensureDeviceId, ensureToken, envTemplate, exampleConfig, loadConfig } from './config.js'
import {
  agentsTemplateDir,
  checkNative,
  currentCli,
  ensureAgents,
  ensureConfig,
  installService,
  serviceName,
  serviceTarget,
  waitHealth,
  type StepResult,
} from './install.js'
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
  .command('instalar')
  .description('Prepara esta maquina: config, agentes iniciais, servico do systemd e teste de saude')
  .option('--sem-servico', 'nao instala o servico do systemd')
  .option('--substituir-servico', 'troca um servico agent-hub que aponta para outra instalacao')
  .action(async (opts: { semServico?: boolean; substituirServico?: boolean }) => {
    const passo = (nome: string, r: StepResult) => console.log(`${r.ok ? 'ok   ' : 'falha'} ${nome}: ${r.detail}`)
    const nativo = await checkNative()
    passo('modulos nativos', nativo)
    if (!nativo.ok) {
      process.exitCode = 1
      return
    }
    const home = configHome()
    passo('configuracao', ensureConfig(home))
    const config = loadConfig()
    passo('agentes', ensureAgents(config.agentsDir, agentsTemplateDir()))
    ensureToken(config.home)
    const envFile = join(config.home, '.env')
    if (!existsSync(envFile)) writeFileSync(envFile, envTemplate, { mode: 0o600 })
    passo('interface', config.webDir ? { ok: true, detail: config.webDir } : { ok: false, detail: 'build da interface nao encontrado' })
    if (opts.semServico) {
      console.log('\nsem servico: rode "agent-hub start" para subir o daemon')
      return
    }
    const alvo = serviceTarget()
    if (alvo && alvo !== currentCli() && !opts.substituirServico) {
      passo('servico', { ok: false, detail: `ja existe um ${serviceName} apontando para ${alvo}; use --substituir-servico para trocar` })
      process.exitCode = 1
      return
    }
    const servico = installService(config.home)
    passo('servico', servico)
    if (!servico.ok) {
      process.exitCode = 1
      return
    }
    const saude = await waitHealth(config.host, config.port)
    passo('saude', saude)
    if (!saude.ok) {
      process.exitCode = 1
      return
    }
    console.log(`\nAbra http://${config.host}:${config.port} e cadastre uma chave em Configuracoes, Chaves.`)
    console.log(`Pastas liberadas para os agentes: ${config.workspaces.join(', ') || 'nenhuma'} (edite em ${join(config.home, 'config.toml')}).`)
    console.log('Modelo local e opcional: com o Ollama em 127.0.0.1:11434, o agente qwen3 passa a funcionar.')
  })

program
  .command('servico')
  .description('Grava o servico do systemd apontando para esta instalacao e reinicia o daemon')
  .action(async () => {
    const config = loadConfig()
    const r = installService(config.home)
    console.log(`${r.ok ? 'ok' : 'falha'}: ${r.detail}`)
    if (!r.ok) {
      process.exitCode = 1
      return
    }
    const saude = await waitHealth(config.host, config.port)
    console.log(`${saude.ok ? 'ok' : 'falha'}: ${saude.detail}`)
    if (!saude.ok) process.exitCode = 1
  })

program
  .command('atualizar')
  .description('Instala a versao nova do pacote e reinicia o servico com o Node atual')
  .argument('[pacote]', 'arquivo .tgz ou URL da versao nova; sem ele, so reescreve o servico e reinicia')
  .action((pacote: string | undefined) => {
    if (pacote) {
      const npm = spawnSync('npm', ['install', '-g', pacote], { stdio: 'inherit' })
      if (npm.status !== 0) {
        process.exitCode = npm.status ?? 1
        return
      }
    }
    const novo = spawnSync(process.execPath, [currentCli(), 'servico'], { stdio: 'inherit' })
    process.exitCode = novo.status ?? 1
  })

program
  .command('env')
  .description('Mostra quais chaves o daemon encontra, sem revelar valores')
  .action(() => {
    const config = loadConfig()
    for (const name of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
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
    const stale = runtime.pricingStaleness()
    if (stale) console.error(`aviso: ${stale}`)
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
  .option('--continuar <run_id>', 'continua um workflow que parou no meio')
  .action(async (nome: string | undefined, opts: { workspace?: string; input?: string[]; continuar?: string }) => {
    const runtime = new Runtime(loadConfig())
    reportErrors(runtime)
    const { WorkflowEngine } = await import('./workflows.js')
    const engine = new WorkflowEngine(runtime, (f) => {
      if (f.type === 'workflow.step') console.log(`[${f.step}] ${f.status}${f.detail ? ` ${f.detail}` : ''}${f.cost_usd !== undefined ? ` ${f.cost_usd.toFixed(4)} USD` : ''}`)
      if (f.type === 'event') printEvent(f.event)
      if (f.type === 'approval.required') void askInTerminalPlain(runtime, f.approval_id, f.tool, f.args)
    })
    if (opts.continuar) {
      const outcome = await engine.resume(opts.continuar)
      console.log(`\n[${outcome.status}] custo ${outcome.costUsd.toFixed(4)} USD${outcome.error ? `: ${outcome.error}` : ''}`)
      runtime.terminals.closeAll()
      await runtime.mcp.close()
      return
    }
    if (!nome) {
      const parados = engine.pending()
      for (const w of engine.list()) {
        console.log(`${w.name}\t${w.mode}\tentradas ${w.inputs.join(',') || '-'}\tteto do workflow ${w.budgetUsd === null ? 'sem teto' : `${w.budgetUsd.toFixed(2)} USD`}\tsoma dos orcamentos ${w.maxCostUsd === null ? 'indefinida' : `${w.maxCostUsd.toFixed(4)} USD`}\t${w.description}`)
      }
      if (parados.length > 0) {
        console.log('\nparados no meio, da para continuar com --continuar <run_id>:')
        for (const p of parados) console.log(`${p.runId}\t${p.name}\t${p.status}\tproxima etapa ${p.nextStep ?? '-'}\t${p.costUsd.toFixed(4)} USD`)
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
    runtime.terminals.closeAll()
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
  .description('Lista perfis e papeis carregados, com os erros de carregamento')
  .action(() => {
    const runtime = new Runtime(loadConfig())
    for (const a of runtime.agents()) console.log(`${a.name}\t${a.provider}/${a.model}\t${a.reasoning}\t${a.description}`)
    const papeis = runtime.roles()
    if (papeis.length > 0) console.log('\npapeis (papel roda em qualquer um dos modelos listados):')
    for (const r of papeis) console.log(`${r.name}\tmodelos: ${r.models.join(', ')}\t${r.description}`)
    reportErrors(runtime)
  })

program
  .command('route <texto>')
  .description('Mostra a decisao do roteador para um pedido, com o ranking custo x capacidade, sem gastar tokens')
  .option('--at <iso>', 'simula outro instante para o preco por horario, ex.: 2026-09-14T02:30:00Z')
  .option('--imagem', 'simula um pedido com imagem anexada, que exige agente com visao')
  .option('--contexto <tokens>', 'simula o historico ja acumulado na sessao, em tokens')
  .option('--papel <nome>', 'restringe aos modelos declarados no papel, como a sessao faria')
  .option('--lote', 'simula tarefa de lote, sem pressa: o custo pesa mais e agentes so de lote entram')
  .action((texto: string, opts: { at?: string; imagem?: boolean; contexto?: string; papel?: string; lote?: boolean }) => {
    const runtime = new Runtime(loadConfig())
    const at = opts.at ? new Date(opts.at) : undefined
    if (at && Number.isNaN(at.getTime())) throw new Error(`instante invalido: ${opts.at}`)
    if (at) console.log(`simulando o instante ${at.toISOString()}`)
    const contexto = opts.contexto === undefined ? undefined : Number(opts.contexto) + approxTokens(texto)
    if (contexto !== undefined && !Number.isFinite(contexto)) throw new Error(`contexto invalido: ${opts.contexto}`)
    if (contexto !== undefined) console.log(`simulando ${contexto} tokens de contexto na chamada`)
    const stale = runtime.pricingStaleness()
    if (stale) console.error(`aviso: ${stale}`)
    const intent = classifyIntent(texto, runtime.repo.routing.intents)
    const delega = needsDelegation(texto)
    const ruled = opts.imagem ? null : route(runtime.repo.routing, { text: texto, workspace: process.cwd() })
    console.log(`intencao por palavra chave: ${intent ?? 'nenhuma'}`)
    if (delega) console.log('pedido fala em subagente ou delegacao: so entram agentes que delegam')
    const modelos = opts.papel ? runtime.role(opts.papel).models : undefined
    if (modelos) console.log(`papel ${opts.papel}: so entram ${modelos.join(', ')}`)
    if (ruled) console.log(`regra: ${JSON.stringify(ruled.rule.when)} -> ${ruled.agent}`)
    const latencia = opts.lote === true ? 'lote' : 'interativo'
    if (opts.lote) console.log('classe de latencia: lote, o custo pesa mais na pontuacao')
    const scored = runtime.scoreFor(intent, texto, at, opts.imagem === true, delega, contexto, modelos, latencia)
    if (scored.ranking.length === 0) {
      console.log('pontuacao desligada: sem bloco scoring em routing.json')
      return
    }
    console.log(['agente', 'pontos', 'capacidade', 'usd/M', 'usd na chamada', 'janela usada', 'situacao'].join('\t'))
    for (const r of scored.ranking) {
      console.log(
        [
          r.agent,
          r.score.toFixed(4),
          `${r.capability.toFixed(2)}${r.adjustment !== 0 ? ` (${r.adjustment > 0 ? '+' : ''}${r.adjustment} aprendido)` : ''}`,
          r.costPerMillion.toFixed(2),
          r.estimatedUsd.toFixed(5),
          `${Math.round(r.contextUse * 100)}%`,
          r.excluded ?? (r.agent === scored.chosen?.agent && !ruled ? 'escolhido' : 'apto'),
        ].join('\t'),
      )
    }
    for (const p of runtime.repo.profiles.values()) {
      const m = runtime.pricing.multiplierAt(p.provider, p.model, at)
      if (m !== 1) console.log(`nota: ${p.name} (${p.provider}/${p.model}) fora de pico ${at ? 'no instante simulado' : 'agora'}, custo x${m}`)
    }
    if (ruled) console.log(`decisao final: ${ruled.agent} (regra vence a pontuacao)`)
    else console.log(`decisao final: ${scored.chosen?.agent ?? runtime.repo.routing.default_agent ?? 'nenhum'}`)
  })

program
  .command('feedback')
  .description('Somatorio de feedback bom/ruim por agente e intencao com o ajuste de capacidade aprendido')
  .action(() => {
    const runtime = new Runtime(loadConfig())
    const rows = runtime.feedbackSummary()
    if (rows.length === 0) {
      console.log('sem feedback registrado')
      return
    }
    console.log(['agente', 'intencao', 'bom', 'ruim', 'ajuste'].join('	'))
    for (const r of rows) console.log([r.agent, r.intent, r.good, r.bad, r.delta >= 0 ? `+${r.delta}` : `${r.delta}`].join('	'))
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
    const stale = runtime.pricingStaleness()
    if (stale) console.error(`aviso: ${stale}`)
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
  .command('senha')
  .description('Define a senha do acesso remoto, lida da entrada padrao para nao ficar no historico do shell')
  .action(async () => {
    const runtime = new Runtime(loadConfig())
    const { AuthStore } = await import('./auth.js')
    const auth = new AuthStore(runtime.db)
    const pedacos: Buffer[] = []
    for await (const parte of process.stdin) pedacos.push(Buffer.from(parte as Buffer))
    const senha = Buffer.concat(pedacos).toString('utf8').trim()
    if (!senha) throw new Error('nada na entrada padrao: use  echo -n "sua senha" | agent-hub-daemon senha')
    auth.definirSenha(senha)
    console.log('senha definida. Dispositivos de fora entram com ela e recebem credencial propria.')
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
    runtime.terminals.closeAll()
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
    case 'verification':
      console.log(`\n[verificacao de ${e.agent}] ${e.ok ? 'passou' : `falhou: ${e.failures.map((f) => f.reason).join('; ')}`}`)
      return
    case 'max_output_retry':
      console.log(`\n[teto estourado no raciocinio] ${e.reasoningTokens} tokens de pensamento sem resposta; repetindo com teto ${e.maxOutput} e esforco ${e.reasoning}`)
      return
    case 'compaction':
      console.log(`\n[compactacao ${e.mode}] ${e.before} para ${e.after} tokens estimados`)
      return
    case 'tools_selected':
      console.log(`\n[ferramentas] ${e.kept} enviadas${e.reused ? ' (as mesmas da mensagem anterior)' : ''}, ${e.dropped} fora, ${e.tokens} tokens de ${e.budget} de teto`)
      return
    case 'mcp_skipped':
      console.log(`\n[conectores fora] ${e.servers.map((s) => `${s.name}: ${s.reason}`).join(' | ')}`)
      return
    case 'knowledge_indexed':
      console.log(`\n[base de conhecimento] ${e.files} arquivos indexados em ${e.chunks} trechos${e.ignored.length ? `, ignorados: ${e.ignored.join(', ')}` : ''}`)
      return
    case 'workspace_context':
      console.log(`\n[contexto do projeto] ${e.tokens} tokens: ${[...e.instructions, ...e.memories].join(', ') || 'nada'}${e.inHistory.length ? `; ja na conversa: ${e.inHistory.join(', ')}` : ''}`)
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
