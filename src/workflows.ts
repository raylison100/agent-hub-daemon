import { Ajv } from 'ajv'
import { randomUUID } from 'node:crypto'
import {
  decide,
  evaluateCondition,
  isToolStep,
  maxWorkflowCost,
  parseExitCode,
  renderArgs,
  renderTemplate,
  summarizeWorkflow,
  validateCall,
  type AgentStep,
  type ServerFrame,
  type StepResult,
  type ToolStep,
  type Workflow,
  type WorkflowSummary,
} from '@agent-hub/core'
import { draftPolicy, type Runtime } from './runtime.js'

export interface WorkflowRunRequest {
  name: string
  inputs: Record<string, string>
  workspace: string
}

interface WorkflowOutcome {
  status: 'done' | 'error' | 'budget_exceeded'
  costUsd: number
  outputs: Record<string, unknown>
  error?: string
}

const ajv = new Ajv({ strict: false, allErrors: true })

/** Executa workflows declarativos: etapas de ferramenta sem modelo, etapas de agente com ferramentas restritas, retry limitado. */
export class WorkflowEngine {
  constructor(
    private readonly runtime: Runtime,
    private readonly broadcast: (frame: ServerFrame) => void,
  ) {}

  list(): WorkflowSummary[] {
    return [...this.runtime.repo.workflows.values()].map((wf) => summarizeWorkflow(wf, this.runtime.repo.profiles))
  }

  async run(req: WorkflowRunRequest): Promise<WorkflowOutcome> {
    const wf = this.runtime.repo.workflows.get(req.name)
    if (!wf) throw new Error(`workflow desconhecido: ${req.name}`)
    for (const input of wf.inputs) if (!(input in req.inputs)) throw new Error(`entrada obrigatoria ausente: ${input}`)
    const workspace = this.runtime.assertWorkspace(req.workspace)
    const firstAgent = wf.steps.find((s) => !isToolStep(s)) as AgentStep | undefined
    const session = this.runtime.store.create(firstAgent?.agent ?? 'workflow', workspace, `[workflow] ${wf.name}`, 'workflow')
    const runId = randomUUID()
    const maxCost = maxWorkflowCost(wf, this.runtime.repo.profiles)
    this.broadcast({ type: 'workflow.started', name: wf.name, session_id: session.id, run_id: runId, max_cost_usd: maxCost })

    const context: Record<string, unknown> = { ...req.inputs }
    const retries = new Map<string, number>()
    let costUsd = 0
    let index = 0
    try {
      while (index < wf.steps.length) {
        const step = wf.steps[index]!
        if (wf.budget_usd !== undefined && costUsd >= wf.budget_usd) {
          return this.finish(wf, session.id, runId, { status: 'budget_exceeded', costUsd, outputs: context, error: `orcamento do workflow esgotado: ${costUsd.toFixed(4)} USD` })
        }
        const started = Date.now()
        this.broadcast({ type: 'workflow.step', session_id: session.id, run_id: runId, step: step.id, status: 'running' })
        let result: StepResult
        try {
          result = isToolStep(step)
            ? await this.runTool(step, context, session.id, runId, workspace, wf.mode)
            : await this.runAgent(step, context, session.id, runId, wf.mode)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.broadcast({ type: 'workflow.step', session_id: session.id, run_id: runId, step: step.id, status: 'error', detail: message, ms: Date.now() - started })
          return this.finish(wf, session.id, runId, { status: 'error', costUsd, outputs: context, error: `etapa ${step.id}: ${message}` })
        }
        costUsd += result.cost_usd ?? 0
        context[step.id] = result
        this.broadcast({ type: 'workflow.step', session_id: session.id, run_id: runId, step: step.id, status: 'done', ms: Date.now() - started, cost_usd: result.cost_usd })

        if (step.retry && evaluateCondition(step.retry.when, result)) {
          const used = retries.get(step.id) ?? 0
          if (used < step.retry.max) {
            retries.set(step.id, used + 1)
            this.broadcast({ type: 'workflow.step', session_id: session.id, run_id: runId, step: step.id, status: 'retry', detail: `volta para ${step.retry.step} (${used + 1}/${step.retry.max})` })
            index = wf.steps.findIndex((s) => s.id === step.retry!.step)
            continue
          }
        }
        index += 1
      }
      return this.finish(wf, session.id, runId, { status: 'done', costUsd, outputs: context })
    } finally {
      const updated = this.runtime.store.get(session.id)
      if (updated) this.broadcast({ type: 'session.updated', session: updated })
    }
  }

  private finish(wf: Workflow, sessionId: string, runId: string, outcome: WorkflowOutcome): WorkflowOutcome {
    this.broadcast({
      type: 'workflow.finished',
      name: wf.name,
      session_id: sessionId,
      run_id: runId,
      status: outcome.status,
      cost_usd: outcome.costUsd,
      outputs: publicOutputs(outcome.outputs),
      error: outcome.error,
    })
    void this.runtime.push.send({ title: `Workflow ${wf.name} ${outcome.status}`, body: `${outcome.costUsd.toFixed(4)} USD`, url: `/session/${sessionId}`, tag: `workflow-${runId}` })
    return outcome
  }

  private async runTool(step: ToolStep, context: Record<string, unknown>, sessionId: string, runId: string, workspace: string, mode: 'draft' | 'normal'): Promise<StepResult> {
    const tool = this.runtime.registry.get(step.tool)
    if (!tool) throw new Error(`ferramenta desconhecida: ${step.tool}`)
    const validated = validateCall(tool.definition, renderArgs(step.args, context))
    if (!validated.ok) throw new Error(validated.error)
    const policy = mode === 'draft' ? draftPolicy : this.runtime.policyFor(this.runtime.repo.profiles.values().next().value!)
    const decision = decide(policy, tool.definition, validated.args)
    if (decision === 'deny') throw new Error(`ferramenta ${step.tool} negada pela politica`)
    if (decision === 'ask') {
      const answer = await this.runtime.requestApproval(sessionId, runId, tool.definition, validated.args, (info) =>
        this.broadcast({
          type: 'approval.required',
          approval_id: info.id,
          session_id: info.sessionId,
          run_id: info.runId,
          tool: info.tool,
          args: info.args,
          risk: info.risk,
          expires_at: info.expiresAt,
        }),
      )
      if (answer === 'deny') throw new Error(`ferramenta ${step.tool} negada pelo usuario`)
    }
    const output = this.runtime.redactor.redact(await tool.handler(validated.args, { workspace }))
    this.runtime.store.recordToolEvent({ sessionId, runId, name: step.tool, args: validated.args, decision: 'workflow', result: output.slice(0, 4000) })
    return { output, exit_code: parseExitCode(output), cost_usd: 0 }
  }

  private async runAgent(step: AgentStep, context: Record<string, unknown>, sessionId: string, runId: string, mode: 'draft' | 'normal'): Promise<StepResult> {
    const profile = this.runtime.profile(step.agent)
    const restricted = step.tools ? { ...profile, tools: { native: step.tools, mcp: [] } } : profile
    let prompt = renderTemplate(step.prompt, context)
    if (step.output_schema) {
      prompt += `\n\nResponda apenas com um JSON valido, sem texto ao redor, conforme este schema:\n${JSON.stringify(step.output_schema)}`
    }
    const attempts = step.output_schema ? 2 : 1
    let lastError = ''
    let costUsd = 0
    for (let attempt = 0; attempt < attempts; attempt++) {
      const text = attempt === 0 ? prompt : `${prompt}\n\nA resposta anterior nao passou na validacao: ${lastError}. Responda apenas o JSON corrigido.`
      const result = await this.runtime.runIsolated(restricted, sessionId, runId, text, {
        policyOverride: mode === 'draft' ? draftPolicy : undefined,
        emit: (event) => {
          const seq = this.runtime.store.appendEvent(sessionId, runId, event)
          this.broadcast({ type: 'event', session_id: sessionId, run_id: runId, seq, event })
        },
        onApproval: (info) =>
          this.broadcast({
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
      costUsd += result.costUsd
      if (result.stop !== 'end') throw new Error(`agente parou com ${result.stop}${result.error ? `: ${result.error}` : ''}`)
      if (!step.output_schema) return { output: result.text, cost_usd: costUsd }
      const parsed = parseJson(result.text)
      const validate = ajv.compile(step.output_schema)
      if (parsed !== undefined && validate(parsed)) return { ...(parsed as Record<string, unknown>), output: result.text, cost_usd: costUsd }
      lastError = parsed === undefined ? 'nao e JSON' : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ')
    }
    throw new Error(`saida nao atende ao schema: ${lastError}`)
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function publicOutputs(context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(context)) {
    if (v && typeof v === 'object' && 'output' in v) {
      const step = v as StepResult
      out[k] = { ...step, output: step.output.slice(0, 2000) }
    } else out[k] = v
  }
  return out
}
