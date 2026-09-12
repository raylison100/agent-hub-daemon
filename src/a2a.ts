import { messageText } from '@agent-hub/core'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import type { ConnectionHub } from './hub.js'
import type { Runtime } from './runtime.js'

interface Tarefa {
  id: string
  sessionId: string
  runId: string
  state: 'submitted' | 'working' | 'completed' | 'failed'
  text: string
  costUsd: number
  error?: string
}

/**
 * Lado servidor do A2A: outro sistema descobre os agentes pelo cartao e manda tarefa por JSON-RPC.
 * A autorizacao e o mesmo token do daemon, no cabecalho Authorization.
 */
export function registerA2A(app: FastifyInstance, runtime: Runtime, hub: ConnectionHub, token: string): void {
  const tarefas = new Map<string, Tarefa>()

  app.get('/.well-known/agent.json', async (_req, reply) => {
    const base = `http://${runtime.config.host}:${runtime.config.port}`
    return reply.send({
      protocolVersion: '0.3.0',
      name: `Agent Hub em ${runtime.config.deviceName}`,
      description: 'Harness multi-provedor com roteamento por custo e capacidade. Cada skill abaixo e um agente configurado.',
      url: `${base}/a2a`,
      preferredTransport: 'JSONRPC',
      version: '0.1.0',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      security: [{ bearer: [] }],
      skills: runtime.agents().map((a) => ({
        id: a.name,
        name: a.name,
        description: a.description,
        tags: [a.provider, a.model],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      })),
    })
  })

  app.post('/a2a', async (req, reply) => {
    const auth = req.headers.authorization
    if (auth !== `Bearer ${token}`) return reply.code(401).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'token invalido' } })
    const body = req.body as { id?: string | number; method?: string; params?: Record<string, unknown> }
    const id = body.id ?? null
    try {
      if (body.method === 'message/send') return reply.send({ jsonrpc: '2.0', id, result: await enviar(body.params ?? {}) })
      if (body.method === 'tasks/get') return reply.send({ jsonrpc: '2.0', id, result: consultar(body.params ?? {}) })
      return reply.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `metodo nao suportado: ${body.method}` } })
    } catch (err) {
      return reply.send({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
    }
  })

  /** message/send: cria sessao, roda e devolve a tarefa com o texto final. */
  async function enviar(params: Record<string, unknown>): Promise<unknown> {
    const message = params.message as { parts?: { kind?: string; text?: string }[] } | undefined
    const texto = (message?.parts ?? [])
      .filter((p) => p.kind === 'text' || typeof p.text === 'string')
      .map((p) => p.text ?? '')
      .join('\n')
      .trim()
    if (!texto) throw new Error('mensagem sem parte de texto')
    const workspace = typeof params.workspace === 'string' ? params.workspace : runtime.config.workspaces[0]
    if (!workspace) throw new Error('nenhum workspace liberado em config.toml')
    const agente = typeof params.agent === 'string' ? params.agent : undefined
    const session = runtime.store.create(agente ?? 'auto', runtime.assertWorkspace(workspace), `[a2a] ${texto.slice(0, 60)}`, 'a2a')
    const taskId = randomUUID()
    const runId = randomUUID()
    const tarefa: Tarefa = { id: taskId, sessionId: session.id, runId, state: 'working', text: '', costUsd: 0 }
    tarefas.set(taskId, tarefa)
    const resultado = await runtime.run({
      sessionId: session.id,
      runId,
      text: texto,
      agentOverride: agente,
      autoApprove: false,
      emit: (event) => {
        const seq = runtime.store.appendEvent(session.id, runId, event)
        hub.broadcast({ type: 'event', session_id: session.id, run_id: runId, seq, event })
      },
      onApproval: (info) =>
        hub.broadcast({
          type: 'approval.required',
          approval_id: info.id,
          session_id: info.sessionId,
          run_id: info.runId,
          tool: info.tool,
          args: info.args,
          risk: info.risk,
          expires_at: info.expiresAt,
        }),
    })
    tarefa.state = resultado.stop === 'end' ? 'completed' : 'failed'
    const ultima = [...resultado.appended].reverse().find((m) => m.role === 'assistant')
    tarefa.text = ultima ? messageText(ultima) : ''
    tarefa.costUsd = resultado.costUsd
    tarefa.error = resultado.error
    return paraTask(tarefa)
  }

  function consultar(params: Record<string, unknown>): unknown {
    const id = typeof params.id === 'string' ? params.id : ''
    const tarefa = tarefas.get(id)
    if (!tarefa) throw new Error(`tarefa desconhecida: ${id}`)
    return paraTask(tarefa)
  }

  function paraTask(t: Tarefa): unknown {
    return {
      id: t.id,
      contextId: t.sessionId,
      kind: 'task',
      status: { state: t.state, timestamp: new Date().toISOString() },
      artifacts: t.text ? [{ artifactId: t.runId, parts: [{ kind: 'text', text: t.text }] }] : [],
      metadata: { cost_usd: t.costUsd, error: t.error },
    }
  }
}
