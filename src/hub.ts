import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  contextDir,
  decisionsDir,
  isRepoRoot,
  hookCatalog,
  listContextFiles,
  memoryDir,
  protocolVersion,
  resolveInside,
  specsDir,
  type ClientFrame,
  type HealthItem,
  type HookConfig,
  type RunMode,
  type ServerFrame,
} from '@agent-hub/core'
import { addServers, agentsUsing, claudeCodeServers, parseServers, profileServers, removeServer, setAgentServers, setEnabled } from './connectors.js'
import { autoAgent, draftPolicy, type Runtime } from './runtime.js'
import type { Scheduler } from './schedules.js'
import type { Triggers } from './triggers.js'
import { WorkflowEngine } from './workflows.js'

export interface Conn {
  send(frame: ServerFrame): void
  authed: boolean
  client: string
}

/** Trata os quadros do protocolo para qualquer conexao, seja socket local ou canal vindo do relay. */
export class ConnectionHub {
  private readonly conns = new Set<Conn>()
  private readonly runs = new Map<string, AbortController>()
  private readonly mcpErrors = new Map<string, string>()
  scheduler!: Scheduler
  triggers!: Triggers
  readonly workflows: WorkflowEngine

  constructor(
    private readonly runtime: Runtime,
    private readonly token: string,
  ) {
    this.workflows = new WorkflowEngine(runtime, (f) => this.broadcast(f))
  }

  attach(conn: Conn): void {
    this.conns.add(conn)
  }

  detach(conn: Conn): void {
    this.conns.delete(conn)
  }

  broadcast = (frame: ServerFrame): void => {
    for (const c of this.conns) if (c.authed) safeSend(c, frame)
  }

  abortAll(): void {
    for (const c of this.runs.values()) c.abort()
  }

  async handle(conn: Conn, frame: ClientFrame): Promise<void> {
    try {
      await this.dispatch(conn, frame)
    } catch (err) {
      conn.send({ type: 'error', message: describe(err), ref: frame.type })
    }
  }

  private async dispatch(conn: Conn, frame: ClientFrame): Promise<void> {
    const runtime = this.runtime
    const send = (f: ServerFrame) => conn.send(f)
    if (frame.type === 'auth.login') {
      if (frame.protocol_version !== protocolVersion) {
        send({ type: 'auth.error', message: `protocolo ${frame.protocol_version} incompativel com ${protocolVersion}` })
        return
      }
      try {
        if (!runtime.auth.conferirSenha(frame.password, conn.client || 'desconhecido')) {
          send({ type: 'auth.error', message: 'senha incorreta' })
          return
        }
      } catch (err) {
        send({ type: 'auth.error', message: describe(err) })
        return
      }
      const criado = runtime.auth.criarDispositivo(frame.device_name)
      conn.authed = true
      conn.client = frame.client
      send({ type: 'auth.credential', credential: criado.credential, device_id: criado.id, device: runtime.config.deviceName })
      send({ type: 'auth.ok', protocol_version: protocolVersion, device: runtime.config.deviceName, senha_definida: true })
      return
    }
    if (frame.type === 'auth') {
      if (frame.protocol_version !== protocolVersion) {
        send({ type: 'auth.error', message: `protocolo ${frame.protocol_version} incompativel com ${protocolVersion}` })
        return
      }
      const dispositivo = safeEqual(frame.token, this.token) ? null : runtime.auth.conferirDispositivo(frame.token)
      if (!safeEqual(frame.token, this.token) && dispositivo === null) {
        send({ type: 'auth.error', message: 'token invalido' })
        return
      }
      conn.authed = true
      conn.client = dispositivo ? `${frame.client} (${dispositivo})` : frame.client
      send({ type: 'auth.ok', protocol_version: protocolVersion, device: runtime.config.deviceName, senha_definida: runtime.auth.temSenha() })
      return
    }
    if (!conn.authed) {
      send({ type: 'auth.error', message: 'autentique primeiro' })
      return
    }
    switch (frame.type) {
      case 'agents.list':
        send({ type: 'agents.list', agents: runtime.agents(), roles: runtime.roles(), errors: runtime.repo.errors })
        return
      case 'session.create': {
        const workspace = runtime.assertWorkspace(frame.workspace)
        const agent = frame.agent === undefined || frame.agent === autoAgent ? autoAgent : runtime.profile(frame.agent).name
        const session = runtime.store.create(agent, workspace, frame.title)
        const comPapel = frame.role ? runtime.store.update(session.id, { role: runtime.role(frame.role).name }) : session
        send({ type: 'session.created', session: comPapel ?? session })
        this.broadcast({ type: 'session.updated', session: comPapel ?? session })
        return
      }
      case 'workspace.roots':
        send({ type: 'workspace.roots', roots: runtime.config.workspaces, wsl_distro: process.env.WSL_DISTRO_NAME ?? null })
        return
      case 'workspace.list': {
        const target = runtime.assertWorkspace(frame.path)
        const dirs = readdirSync(target, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b))
        send({ type: 'workspace.list', path: target, dirs, repo: isRepoRoot(target), repos: dirs.filter((d) => isRepoRoot(join(target, d))) })
        return
      }
      case 'hooks.list':
        send(this.hooksFrame())
        return
      case 'hooks.toggle': {
        const item = hookCatalog.find((h) => h.id === frame.id)
        if (!item) throw new Error(`gancho desconhecido: ${frame.id}`)
        const file = join(runtime.config.agentsDir, 'hooks.json')
        const atuais = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { hooks: HookConfig[] }) : { hooks: [] }
        const iguais = (h: HookConfig) => h.event === item.hook.event && h.command === item.hook.command
        atuais.hooks = frame.enabled ? [...atuais.hooks.filter((h) => !iguais(h)), item.hook] : atuais.hooks.filter((h) => !iguais(h))
        writeFileSync(file, `${JSON.stringify(atuais, null, 2)}\n`)
        runtime.reload()
        send(this.hooksFrame())
        return
      }
      case 'auth.password':
        runtime.auth.definirSenha(frame.password)
        send({ type: 'auth.devices', devices: runtime.auth.dispositivos(), senha_definida: true })
        return
      case 'auth.devices':
        send({ type: 'auth.devices', devices: runtime.auth.dispositivos(), senha_definida: runtime.auth.temSenha() })
        return
      case 'auth.revoke':
        if (!runtime.auth.revogar(frame.device_id)) throw new Error('dispositivo nao encontrado')
        send({ type: 'auth.devices', devices: runtime.auth.dispositivos(), senha_definida: runtime.auth.temSenha() })
        return
      case 'health.list':
        send({ type: 'health.list', items: this.health() })
        return
      case 'context.list': {
        const dir = runtime.assertWorkspace(frame.workspace)
        send({
          type: 'context.list',
          workspace: dir,
          memories: runtime.contextFiles(dir, memoryDir),
          specs: listContextFiles(dir, specsDir),
          decisions: listContextFiles(dir, decisionsDir),
        })
        return
      }
      case 'context.delete': {
        const dir = runtime.assertWorkspace(frame.workspace)
        const alvo = resolveInside(dir, frame.file)
        if (!/\.md$/.test(alvo) || !alvo.includes(`${contextDir}`)) throw new Error(`so da para apagar arquivo dentro de ${contextDir}`)
        rmSync(alvo, { force: true })
        send({
          type: 'context.list',
          workspace: dir,
          memories: runtime.contextFiles(dir, memoryDir),
          specs: listContextFiles(dir, specsDir),
          decisions: listContextFiles(dir, decisionsDir),
        })
        return
      }
      case 'workspace.find': {
        const alvo = frame.name.trim().toLowerCase()
        const achados: string[] = []
        const varrer = (dir: string, profundidade: number): void => {
          if (profundidade > 4 || achados.length >= 20) return
          let filhos: string[] = []
          try {
            filhos = readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
              .map((e) => e.name)
          } catch {
            return
          }
          for (const nome of filhos) {
            const caminho = join(dir, nome)
            if (nome.toLowerCase() === alvo) achados.push(caminho)
            varrer(caminho, profundidade + 1)
          }
        }
        for (const raiz of runtime.config.workspaces) {
          if (raiz.split('/').filter(Boolean).pop()?.toLowerCase() === alvo) achados.push(raiz)
          varrer(raiz, 1)
        }
        send({ type: 'workspace.find', name: frame.name, paths: [...new Set(achados)] })
        return
      }
      case 'feedback.set': {
        runtime.setFeedback(frame.session_id, frame.run_id, frame.verdict)
        this.broadcast({ type: 'feedback.ok', session_id: frame.session_id, run_id: frame.run_id, verdict: frame.verdict })
        return
      }
      case 'feedback.list':
        send({ type: 'feedback.list', session_id: frame.session_id, items: runtime.feedbackList(frame.session_id) })
        return
      case 'feedback.summary':
        send({ type: 'feedback.summary', rows: runtime.feedbackSummary() })
        return
      case 'term.open': {
        const session = runtime.store.get(frame.session_id)
        if (!session) throw new Error('sessao nao encontrada')
        if (frame.term_id && runtime.terminals.has(frame.term_id)) {
          send({ type: 'term.opened', term_id: frame.term_id, session_id: frame.session_id, cwd: session.workspace, buffer: runtime.terminals.buffer(frame.term_id) })
          runtime.terminals.resize(frame.term_id, frame.cols, frame.rows)
          return
        }
        const termId = runtime.terminals.open({
          cwd: session.workspace,
          cols: frame.cols,
          rows: frame.rows,
          env: process.env,
          onData: (data) => this.broadcast({ type: 'term.data', term_id: termId, data }),
          onExit: (code) => this.broadcast({ type: 'term.exit', term_id: termId, code }),
        })
        send({ type: 'term.opened', term_id: termId, session_id: frame.session_id, cwd: session.workspace, buffer: '' })
        return
      }
      case 'term.input':
        runtime.terminals.write(frame.term_id, frame.data)
        return
      case 'term.resize':
        runtime.terminals.resize(frame.term_id, frame.cols, frame.rows)
        return
      case 'term.close':
        runtime.terminals.close(frame.term_id)
        return
      case 'tasks.list':
        send({ type: 'tasks.list', tasks: runtime.backgroundTasks(frame.session_id) })
        return
      case 'stats.overview':
        send({ type: 'stats.overview', stats: runtime.statsOverview(frame.days) })
        return
      case 'routing.info':
        send({
          type: 'routing.info',
          default_agent: runtime.repo.routing.default_agent ?? null,
          improver: runtime.repo.routing.prompt_improver?.agent ?? null,
          classifier: runtime.repo.routing.classifier?.agent ?? null,
        })
        return
      case 'session.list':
        send({ type: 'session.list', sessions: runtime.store.list(frame.limit, frame.include_archived) })
        return
      case 'session.update': {
        const agent = frame.agent === undefined ? undefined : frame.agent === autoAgent ? autoAgent : runtime.profile(frame.agent).name
        const role = frame.role === undefined || frame.role === null ? frame.role : runtime.role(frame.role).name
        const session = runtime.store.update(frame.session_id, { title: frame.title, pinned: frame.pinned, archived: frame.archived, agent, role, mode: frame.mode, group: frame.group })
        if (!session) throw new Error('sessao nao encontrada')
        if (frame.mode === 'auto_approve') {
          for (const id of runtime.flushApprovals(frame.session_id)) this.broadcast({ type: 'approval.resolved', approval_id: id, decision: 'allow' })
        }
        this.broadcast({ type: 'session.updated', session })
        return
      }
      case 'session.update_many': {
        const atualizadas = runtime.store.updateMany(frame.session_ids, { pinned: frame.pinned, archived: frame.archived, group: frame.group })
        for (const s of atualizadas) this.broadcast({ type: 'session.updated', session: s })
        return
      }
      case 'session.delete_many': {
        const apagadas = runtime.store.deleteMany(frame.session_ids)
        this.broadcast({ type: 'session.deleted_many', session_ids: apagadas })
        return
      }
      case 'session.delete': {
        if (this.runs.size > 0) {
          for (const [, c] of this.runs) c.signal.aborted
        }
        if (!runtime.store.delete(frame.session_id)) throw new Error('sessao nao encontrada')
        this.broadcast({ type: 'session.deleted', session_id: frame.session_id })
        return
      }
      case 'session.resume':
        send({ type: 'session.resume', session_id: frame.session_id, resume: runtime.store.resume(frame.session_id) })
        return
      case 'session.fork': {
        const session = runtime.store.fork(frame.session_id)
        if (!session) throw new Error('sessao nao encontrada')
        send({ type: 'session.created', session })
        this.broadcast({ type: 'session.updated', session })
        return
      }
      case 'session.get': {
        const session = runtime.store.get(frame.session_id)
        if (!session) throw new Error('sessao nao encontrada')
        send({
          type: 'session.get',
          session,
          messages: runtime.store.history(frame.session_id),
          children: runtime.store.children(frame.session_id).map((c) => ({ run_id: c.runId, parent_run_id: c.parentRunId, agent: c.agent, messages: c.messages })),
          resume: runtime.store.resume(frame.session_id),
        })
        return
      }
      case 'sync':
        send({ type: 'sync', session_id: frame.session_id, events: runtime.store.eventsSince(frame.session_id, frame.since_seq) })
        return
      case 'run.start':
        this.startRun(frame.session_id, frame.text, send, frame.mode, frame.reasoning, frame.agent, frame.improve, frame.images, frame.role)
        return
      case 'cost.status': {
        const s = runtime.costStatus()
        send({
          type: 'cost.status',
          today_usd: s.todayUsd,
          month_usd: s.monthUsd,
          global_month_limit_usd: s.globalMonthLimit,
          agents: Object.fromEntries(Object.entries(s.agents).map(([k, v]) => [k, { today_usd: v.todayUsd, day_limit_usd: v.dayLimit }])),
        })
        return
      }
      case 'cost.export': {
        const out = runtime.ledger.exportCsv({ since: frame.since, until: frame.until })
        send({ type: 'cost.export', csv: out.csv, rows: out.rows })
        return
      }
      case 'run.cancel':
        this.runs.get(frame.run_id)?.abort()
        return
      case 'approval.respond': {
        const ok = runtime.approvals.respond(frame.approval_id, frame.decision)
        if (!ok) throw new Error('aprovacao nao encontrada ou expirada')
        this.broadcast({ type: 'approval.resolved', approval_id: frame.approval_id, decision: frame.decision })
        return
      }
      case 'cost.report':
        send({ type: 'cost.report', rows: runtime.ledger.report(frame.group, { since: frame.since }) })
        return
      case 'budget.override': {
        const ok = runtime.overrideBudget(frame.run_id, frame.scope, frame.limit_usd)
        if (!ok) throw new Error('run nao esta ativo')
        this.broadcast({ type: 'budget.overridden', run_id: frame.run_id, scope: frame.scope, limit_usd: frame.limit_usd })
        return
      }
      case 'schedule.list':
        send({ type: 'schedule.list', schedules: this.scheduler.list(), paused: this.scheduler.paused })
        return
      case 'schedule.upsert':
        this.scheduler.upsert(frame.schedule)
        return
      case 'schedule.delete':
        if (!this.scheduler.delete(frame.id)) throw new Error('agendamento nao encontrado')
        return
      case 'schedule.run_now':
        void this.scheduler.runNow(frame.id).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
        return
      case 'automation.pause':
        runtime.automation.setPaused(true)
        return
      case 'automation.resume':
        runtime.automation.setPaused(false)
        return
      case 'automation.runs':
        send({ type: 'automation.runs', runs: runtime.automation.runs(frame.automation_id, frame.limit) })
        return
      case 'trigger.list':
        send({ type: 'trigger.list', triggers: this.triggers.list() })
        return
      case 'trigger.upsert':
        this.triggers.upsert(frame.trigger)
        return
      case 'trigger.delete':
        if (!this.triggers.delete(frame.id)) throw new Error('gatilho nao encontrado')
        return
      case 'mcp.servers': {
        send({ type: 'mcp.servers', servers: this.serverList() })
        return
      }
      case 'mcp.add': {
        const result = addServers(runtime.config.agentsDir, parseServers(frame.text))
        runtime.reload()
        send({ type: 'mcp.saved', added: result.added, secrets: result.secrets })
        this.broadcast({ type: 'mcp.servers', servers: this.serverList() })
        return
      }
      case 'mcp.import': {
        const found = claudeCodeServers()
        if (Object.keys(found).length === 0) throw new Error('nenhum servidor MCP encontrado no Claude Code deste usuario')
        const result = addServers(runtime.config.agentsDir, found)
        runtime.reload()
        send({ type: 'mcp.saved', added: result.added, secrets: result.secrets })
        this.broadcast({ type: 'mcp.servers', servers: this.serverList() })
        return
      }
      case 'mcp.connect': {
        await this.connectMcp(frame.name)
        send({ type: 'mcp.saved', added: [], secrets: [] })
        this.broadcast({ type: 'mcp.servers', servers: this.serverList() })
        return
      }
      case 'mcp.agents': {
        const dir = runtime.config.agentsDir
        for (const profile of runtime.repo.profiles.keys()) {
          const atual = agentsUsing(dir, frame.name)
          const querUsar = frame.agents.includes(profile)
          if (atual.includes(profile) === querUsar) continue
          const servers = new Set(profileServers(dir, profile))
          if (querUsar) servers.add(frame.name)
          else servers.delete(frame.name)
          setAgentServers(dir, profile, [...servers])
        }
        runtime.reload()
        send({ type: 'mcp.agents', name: frame.name, agents: agentsUsing(dir, frame.name) })
        return
      }
      case 'mcp.remove': {
        await runtime.mcp.close(frame.name)
        if (!removeServer(runtime.config.agentsDir, frame.name)) throw new Error(`servidor nao encontrado: ${frame.name}`)
        runtime.reload()
        send({ type: 'mcp.saved', added: [], secrets: [] })
        this.broadcast({ type: 'mcp.servers', servers: this.serverList() })
        return
      }
      case 'mcp.toggle': {
        if (!setEnabled(runtime.config.agentsDir, frame.name, frame.enabled)) throw new Error(`servidor nao encontrado: ${frame.name}`)
        runtime.reload()
        if (!frame.enabled) await runtime.mcp.close(frame.name)
        else await this.connectMcp(frame.name)
        send({ type: 'mcp.saved', added: [], secrets: [] })
        this.broadcast({ type: 'mcp.servers', servers: this.serverList() })
        return
      }
      case 'mcp.resources':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.resources', server: frame.server, resources: await runtime.mcp.resources(frame.server) })
        return
      case 'mcp.resource.read':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.resource.read', server: frame.server, uri: frame.uri, text: await runtime.mcp.readResource(frame.server, frame.uri) })
        return
      case 'mcp.prompts':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.prompts', server: frame.server, prompts: await runtime.mcp.prompts(frame.server) })
        return
      case 'mcp.prompt.get':
        await this.connectMcp(frame.server)
        send({ type: 'mcp.prompt.get', server: frame.server, name: frame.name, text: await runtime.mcp.getPrompt(frame.server, frame.name, frame.args ?? {}) })
        return
      case 'push.vapid':
        send({ type: 'push.vapid', public_key: runtime.push.publicKey, subscriptions: runtime.push.count() })
        return
      case 'push.subscribe':
        runtime.push.subscribe(frame.subscription, conn.client)
        send({ type: 'push.subscribed', endpoint: frame.subscription.endpoint })
        return
      case 'push.unsubscribe':
        runtime.push.unsubscribe(frame.endpoint)
        return
      case 'push.test':
        await runtime.push.send({ title: 'Agent Hub', body: `Notificacoes ativas em ${runtime.config.deviceName}`, tag: 'teste' })
        return
      case 'workflow.list':
        send({ type: 'workflow.list', workflows: this.workflows.list(), pending: this.workflows.pending() })
        return
      case 'secrets.list':
        send({ type: 'secrets.list', secrets: runtime.secrets.list().map((s) => ({ name: s.name, hint: s.hint, length: s.length, updated_at: s.updatedAt, source: s.source })) })
        return
      case 'secrets.set':
        runtime.secrets.set(frame.name, frame.value)
        send({ type: 'secrets.list', secrets: runtime.secrets.list().map((s) => ({ name: s.name, hint: s.hint, length: s.length, updated_at: s.updatedAt, source: s.source })) })
        return
      case 'fs.list': {
        const workspace = this.workspaceOf(frame.session_id, frame.workspace)
        const dir = resolveInside(workspace, frame.path ?? '.')
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => !['node_modules', '.git', 'dist', 'vendor'].includes(e.name))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        send({ type: 'fs.list', path: relative(workspace, dir) || '.', entries })
        return
      }
      case 'fs.read': {
        const workspace = this.workspaceOf(frame.session_id, frame.workspace)
        const file = resolveInside(workspace, frame.path)
        const max = frame.max_chars ?? 60_000
        const raw = readFileSync(file, 'utf8')
        send({ type: 'fs.read', path: relative(workspace, file), text: raw.slice(0, max), truncated: raw.length > max })
        return
      }
      case 'fs.tree': {
        const workspace = this.workspaceOf(frame.session_id, frame.workspace)
        const dir = resolveInside(workspace, frame.path ?? '.')
        send({ type: 'fs.tree', path: relative(workspace, dir) || '.', text: tree(dir, frame.depth ?? 3) })
        return
      }
      case 'skills.list': {
        const allowed = frame.agent ? new Set(runtime.profile(frame.agent).skills) : null
        send({
          type: 'skills.list',
          skills: [...runtime.repo.skills.values()]
            .filter((s) => !allowed || allowed.has(s.name))
            .map((s) => ({ name: s.name, description: s.description, source: s.name.includes(':') ? 'plugin' : 'agents' })),
        })
        return
      }
      case 'skill.get': {
        const skill = runtime.repo.skills.get(frame.name)
        if (!skill) throw new Error(`skill desconhecida: ${frame.name}`)
        send({ type: 'skill.get', name: skill.name, body: skill.body })
        return
      }
      case 'plugins.list':
        send({
          type: 'plugins.list',
          plugins: runtime.repo.plugins.map((p) => ({ name: p.name, dir: p.dir, skills: p.skills.size, agents: p.profiles.size, mcp: Object.keys(p.mcp).length, hooks: p.hooks.length })),
        })
        return
      case 'secrets.delete':
        runtime.secrets.delete(frame.name)
        send({ type: 'secrets.list', secrets: runtime.secrets.list().map((s) => ({ name: s.name, hint: s.hint, length: s.length, updated_at: s.updatedAt, source: s.source })) })
        return
      case 'workflow.run':
        void this.workflows.run({ name: frame.name, inputs: frame.inputs, workspace: frame.workspace }).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
        return
      case 'workflow.resume':
        void this.workflows.resume(frame.run_id).catch((err: unknown) => send({ type: 'error', message: describe(err), ref: frame.type }))
        return
    }
  }

  /** Estado de cada servidor MCP declarado, com transporte, ligado e quantas ferramentas expoe. */
  serverList() {
    const connected = new Set(this.runtime.mcp.connected())
    return Object.entries(this.runtime.repo.mcp.servers).map(([name, cfg]) => ({
      name,
      connected: connected.has(name),
      enabled: cfg.enabled,
      transport: cfg.url ? ('http' as const) : ('stdio' as const),
      command: cfg.command ?? '',
      args: cfg.args,
      url: cfg.url ?? null,
      tools: this.runtime.registry.names().filter((t) => t.startsWith(`${name}__`)).length,
      error: this.mcpErrors.get(name) ?? null,
      agents: agentsUsing(this.runtime.config.agentsDir, name),
      oauth: cfg.oauth ? (this.runtime.oauth.autorizado(name) ? ("autorizado" as const) : ("pendente" as const)) : null,
    }))
  }

  /** Workspace alvo de um frame de arquivos: pela sessao quando existe, senao pelo caminho informado, sempre validado contra as raizes. */
  private workspaceOf(sessionId?: string, workspace?: string): string {
    if (sessionId) {
      const session = this.runtime.store.get(sessionId)
      if (!session) throw new Error('sessao nao encontrada')
      return session.workspace
    }
    if (workspace) return this.runtime.assertWorkspace(workspace)
    throw new Error('informe session_id ou workspace')
  }

  /** Conecta sob demanda e guarda a ultima falha, para a tela de conectores mostrar o motivo. */
  /** Conecta um conector guardando o ultimo erro, para a tela dizer Falhou com o motivo em vez de Conectando para sempre. */
  async connectMcp(name: string): Promise<void> {
    try {
      await this.runtime.ensureMcpServer(name)
      this.mcpErrors.delete(name)
    } catch (err) {
      this.mcpErrors.set(name, describe(err))
      throw err
    }
  }




  /** Catalogo de ganchos prontos com o que ja esta ligado em hooks.json marcado. */
  private hooksFrame(): ServerFrame {
    const ativos = this.runtime.repo.hooks
    const catalog = hookCatalog.map((h) => ({
      id: h.id,
      title: h.title,
      detail: h.detail,
      event: h.hook.event,
      tool: h.hook.match.tool,
      enabled: ativos.some((a) => a.event === h.hook.event && a.command === h.hook.command),
    }))
    const doCatalogo = new Set(hookCatalog.map((h) => h.hook.command))
    return { type: 'hooks.list', catalog, extras: ativos.filter((a) => !doCatalogo.has(a.command)).length }
  }
  /** Painel de saude: so o que precisa de acao sua, com a proxima acao dita em uma linha. */
  private health(): HealthItem[] {
    const runtime = this.runtime
    const itens: HealthItem[] = []
    const pendentes = runtime.approvals.list()
    if (pendentes.length > 0) {
      itens.push({
        level: 'aviso',
        title: `${pendentes.length} aprovacao(oes) esperando`,
        detail: pendentes.map((p) => p.tool).join(', '),
        action: 'Abra a conversa e responda, ou o pedido expira e o run para',
        route: `/session/${pendentes[0]!.sessionId}`,
      })
    }
    const desde = Date.now() - 24 * 60 * 60 * 1000
    const falhas = runtime.store.recentFailures(desde)
    if (falhas.length > 0) {
      itens.push({
        level: 'erro',
        title: `${falhas.length} run(s) terminaram mal nas ultimas 24h`,
        detail: falhas.map((f) => `${f.stop}${f.error ? `: ${f.error.slice(0, 60)}` : ''}`).join(' | '),
        action: 'Veja o motivo na conversa antes de repetir o pedido',
        route: falhas[0] ? `/session/${falhas[0].sessionId}` : undefined,
      })
    }
    const comErro = [...this.mcpErrors.entries()]
    if (comErro.length > 0) {
      itens.push({
        level: 'erro',
        title: `${comErro.length} conector(es) com erro`,
        detail: comErro.map(([nome, erro]) => `${nome}: ${erro.slice(0, 80)}`).join(' | '),
        action: 'Confira comando, URL e chaves em Conectores',
        route: '/settings/conectores',
      })
    }
    const custo = runtime.costStatus()
    if (custo.globalMonthLimit !== null && custo.monthUsd > custo.globalMonthLimit * 0.8) {
      itens.push({
        level: custo.monthUsd >= custo.globalMonthLimit ? 'erro' : 'aviso',
        title: `Orcamento do mes em ${((custo.monthUsd / custo.globalMonthLimit) * 100).toFixed(0)}%`,
        detail: `${custo.monthUsd.toFixed(2)} de ${custo.globalMonthLimit.toFixed(2)} USD`,
        action: 'Suba o teto em budgets.json ou segure os agentes caros',
        route: '/settings/custos',
      })
    }
    const precos = runtime.pricingStaleness()
    if (precos) {
      itens.push({ level: 'aviso', title: 'Tabela de precos velha', detail: precos, action: 'Rode o agendamento revisao-precos e atualize o que mudou', route: '/settings/automacoes' })
    }
    const memoria = runtime.staleMemories()
    if (memoria) {
      itens.push({ level: 'aviso', title: 'Memoria do projeto envelhecendo', detail: memoria.detalhe, action: 'Confira contra o codigo e apague o que nao vale mais', route: '/settings/contexto' })
    }
    if (itens.length === 0) {
      itens.push({ level: 'ok', title: 'Nada pedindo atencao', detail: 'Sem aprovacao parada, sem run quebrado, sem conector com erro', action: 'Pode tocar o trabalho' })
    }
    return itens
  }
  /** Escreve o ponto de retomada em segundo plano e avisa os clientes. Falha aqui nao atrapalha o run que ja terminou. */
  private async gerarRetomada(sessionId: string, runId: string): Promise<void> {
    try {
      const registro = await this.runtime.makeResume(sessionId, runId)
      if (registro) this.broadcast({ type: 'session.resume', session_id: sessionId, resume: registro })
    } catch (err) {
      console.error(`retomada da sessao ${sessionId}: ${describe(err)}`)
    }
  }

  private startRun(
    sessionId: string,
    text: string,
    send: (f: ServerFrame) => void,
    mode: RunMode = 'normal',
    reasoning?: 'low' | 'medium' | 'high' | 'max',
    agent?: string,
    improve?: boolean,
    images?: { media_type: string; data: string; name?: string }[],
    role?: string,
  ): void {
    const runtime = this.runtime
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, controller)
    send({ type: 'run.started', run_id: runId, session_id: sessionId })
    const withMode = runtime.store.update(sessionId, { mode })
    if (withMode) this.broadcast({ type: 'session.updated', session: withMode })
    const policyOverride = mode === 'draft' ? draftPolicy : mode === 'accept_edits' ? { read: 'allow' as const, write: 'allow' as const, exec: 'ask' as const } : undefined
    void runtime
      .run({
        sessionId,
        text,
        runId,
        signal: controller.signal,
        policyOverride,
        autoApprove: mode === 'auto_approve',
        reasoningOverride: reasoning,
        agentOverride: agent && agent !== autoAgent ? agent : undefined,
        roleOverride: role,
        improve,
        images: images?.map((i) => ({ mediaType: i.media_type, data: i.data, name: i.name })),
        emit: (event) => {
          const seq = runtime.store.appendEvent(sessionId, runId, event)
          this.broadcast({ type: 'event', session_id: sessionId, run_id: runId, seq, event })
          if (event.type === 'run_finished') {
            void runtime.hooks.emit('run.end', { session_id: sessionId, run_id: runId, stop: event.stop, cost_usd: event.costUsd, steps: event.steps })
            if (event.stop === 'budget_exceeded') void runtime.hooks.emit('budget.exceeded', { session_id: sessionId, run_id: runId, message: event.error ?? '' })
            void runtime.push.send({
              title: `Run ${event.stop === 'end' ? 'concluido' : event.stop}`,
              body: `${event.steps} passos, ${event.costUsd.toFixed(4)} USD`,
              url: `/session/${sessionId}`,
              tag: `run-${runId}`,
            })
          }
        },
        onApproval: (info) => {
          const frame: ServerFrame = {
            type: 'approval.required',
            approval_id: info.id,
            session_id: info.sessionId,
            run_id: info.runId,
            tool: info.tool,
            args: info.args,
            risk: info.risk,
            expires_at: info.expiresAt,
          }
          this.broadcast(frame)
          void runtime.hooks.emit('approval.required', { approval_id: info.id, session_id: info.sessionId, tool: info.tool, risk: info.risk, expires_at: info.expiresAt })
          void runtime.push.send({
            title: `Aprovar ${info.tool}?`,
            body: JSON.stringify(info.args).slice(0, 120),
            url: `/session/${info.sessionId}`,
            tag: `approval-${info.id}`,
          })
        },
      })
      .catch((err: unknown) => this.broadcast({ type: 'error', message: describe(err), ref: runId }))
      .finally(() => {
        this.runs.delete(runId)
        const session = runtime.store.get(sessionId)
        if (session) this.broadcast({ type: 'session.updated', session })
        void this.gerarRetomada(sessionId, runId)
      })
  }
}

/** Arvore de diretorios em texto, limitada em profundidade e em 400 linhas. */
function tree(dir: string, depth: number): string {
  const lines: string[] = []
  const skip = new Set(['node_modules', '.git', 'dist', 'vendor', '.next', 'build', 'target'])
  const walk = (d: string, prefix: string, level: number) => {
    if (level > depth || lines.length > 400) return
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (skip.has(e.name)) continue
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`)
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}  `, level + 1)
    }
  }
  walk(dir, '', 1)
  return lines.join('\n')
}

function safeSend(conn: Conn, frame: ServerFrame): void {
  try {
    conn.send(frame)
  } catch {
    return
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
