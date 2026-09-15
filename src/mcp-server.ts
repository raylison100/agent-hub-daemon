import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { NodeDaemonClient, type RunEvent, type ServerFrame } from '@agent-hub/core'

export interface McpServerOptions {
  url: string
  token: string
  accountToken?: string
  deviceId?: string
  runTimeoutMs: number
}

/** Expoe o daemon como servidor MCP por stdio, para outros clientes MCP dispararem agentes nesta maquina. */
export async function serveMcp(opts: McpServerOptions): Promise<void> {
  const log = (m: string) => console.error(`[mcp] ${m}`)
  const daemon = new NodeDaemonClient({ url: opts.url, token: opts.token, accountToken: opts.accountToken, deviceId: opts.deviceId, client: 'mcp', log })
  daemon.start()
  await daemon.ready(15000)

  const server = new McpServer({ name: 'agent-hub', version: '0.1.0' })

  server.registerTool(
    'list_agents',
    { description: 'Lista os perfis de agente disponiveis no daemon, com provedor, modelo e orcamento.', inputSchema: {} },
    async () => {
      const res = await daemon.request({ type: 'agents.list' }, 'agents.list')
      return text(res.agents.map((a) => `${a.name} (${a.provider}/${a.model}, ${a.reasoning}): ${a.description}`).join('\n'))
    },
  )

  server.registerTool(
    'list_sessions',
    { description: 'Lista as sessoes recentes com agente, workspace e custo.', inputSchema: { limit: z.number().int().positive().max(100).optional() } },
    async ({ limit }) => {
      const res = await daemon.request({ type: 'session.list', limit: limit ?? 20 }, 'session.list')
      return text(res.sessions.map((s) => `${s.id} | ${s.agent} | ${s.workspace} | ${s.costUsd.toFixed(4)} USD | ${s.title}`).join('\n') || 'nenhuma sessão')
    },
  )

  server.registerTool(
    'run_agent',
    {
      description:
        'Executa uma tarefa com um agente na maquina do daemon e devolve a resposta final com o custo. ' +
        'Sem session_id, cria uma sessao no workspace informado. mode: draft (padrao, sem escrita nem execucao), normal (politica do perfil, aprovacoes podem expirar) ou auto_approve.',
      inputSchema: {
        text: z.string().min(1),
        session_id: z.string().optional(),
        agent: z.string().optional(),
        workspace: z.string().optional(),
        mode: z.enum(['draft', 'normal', 'auto_approve']).optional(),
      },
    },
    async ({ text: task, session_id, agent, workspace, mode }) => {
      let sessionId = session_id
      if (!sessionId) {
        if (!workspace) throw new Error('informe session_id ou workspace')
        const created = await daemon.request({ type: 'session.create', workspace, agent, text: task }, 'session.created')
        sessionId = created.session.id
      }
      const result = await runAndWait(daemon, sessionId, task, mode ?? 'draft', opts.runTimeoutMs)
      return text(`${result.text}\n\n[sessão ${sessionId}, parada ${result.stop}, ${result.steps} passos, ${result.costUsd.toFixed(4)} USD]`)
    },
  )

  server.registerTool(
    'cost_report',
    {
      description: 'Relatorio de custo do ledger agrupado por agente, modelo, sessao ou dia.',
      inputSchema: { group: z.enum(['agent', 'model', 'session', 'day']).optional(), days: z.number().int().positive().max(365).optional() },
    },
    async ({ group, days }) => {
      const since = days ? Date.now() - days * 86_400_000 : undefined
      const res = await daemon.request({ type: 'cost.report', group: group ?? 'agent', since }, 'cost.report')
      const total = res.rows.reduce((a, r) => a + r.costUsd, 0)
      return text([...res.rows.map((r) => `${r.key}: ${r.costUsd.toFixed(4)} USD em ${r.calls} chamadas`), `total: ${total.toFixed(4)} USD`].join('\n'))
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('servidor MCP pronto por stdio')
}

interface RunOutcome {
  text: string
  stop: string
  steps: number
  costUsd: number
}

function runAndWait(daemon: NodeDaemonClient, sessionId: string, task: string, mode: 'draft' | 'normal' | 'auto_approve', timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let runId = ''
    const timer = setTimeout(() => {
      off()
      if (runId) daemon.send({ type: 'run.cancel', run_id: runId })
      reject(new Error(`run excedeu ${timeoutMs} ms`))
    }, timeoutMs)
    const off = daemon.on((f: ServerFrame) => {
      if (f.type !== 'event' || f.run_id !== runId) return
      const e: RunEvent = f.event
      if (e.type === 'text_delta') chunks.push(e.delta)
      if (e.type === 'run_finished') {
        clearTimeout(timer)
        off()
        resolve({ text: chunks.join('').trim() || e.error || '(sem texto)', stop: e.stop, steps: e.steps, costUsd: e.costUsd })
      }
    })
    daemon
      .request({ type: 'run.start', session_id: sessionId, text: task, mode }, 'run.started')
      .then((started) => {
        runId = started.run_id
      })
      .catch((err: unknown) => {
        clearTimeout(timer)
        off()
        reject(err as Error)
      })
  })
}

function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] }
}
