import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AutomationRun, ServerFrame } from '@agent-hub/core'
import { draftPolicy, type Runtime } from './runtime.js'

export interface AutomationSpec {
  kind: 'schedule' | 'trigger'
  id: string
  agent: string
  workspace: string
  prompt: string
  mode: 'draft' | 'normal'
  budget: { run_usd: number; day_usd: number }
  overlap: 'queue' | 'skip'
}

export interface ExecuteOptions {
  manual?: boolean
  title: string
  onStarted?: (sessionId: string, runId: string) => void
}

interface AutomationRunRow {
  id: string
  kind: 'schedule' | 'trigger'
  automation_id: string
  session_id: string
  run_id: string
  started_at: number
  finished_at: number | null
  status: string
  cost_usd: number
}

const pausedKey = 'automation.paused'

/** Executa automacoes com as regras comuns: orcamento diario, modo rascunho, uma execucao por vez e interruptor geral. */
export class AutomationRunner {
  private readonly running = new Set<string>()
  private readonly queued = new Map<string, { spec: AutomationSpec; opts: ExecuteOptions }>()
  paused: boolean

  constructor(
    private readonly runtime: Runtime,
    private readonly db: Database,
    private readonly broadcast: (frame: ServerFrame) => void,
  ) {
    this.paused = runtime.store.setting(pausedKey) === '1'
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.runtime.store.setSetting(pausedKey, paused ? '1' : '0')
    this.broadcast({ type: 'automation.state', paused })
  }

  isRunning(kind: string, id: string): boolean {
    return this.running.has(`${kind}:${id}`)
  }

  spentToday(id: string): number {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM automation_runs WHERE automation_id = ? AND started_at >= ?')
      .get(id, start.getTime()) as { total: number }
    return row.total
  }

  runs(automationId?: string, limit = 50): AutomationRun[] {
    const rows = (
      automationId
        ? this.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?').all(automationId, limit)
        : this.db.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as AutomationRunRow[]
    return rows.map(toAutomationRun)
  }

  async execute(spec: AutomationSpec, opts: ExecuteOptions): Promise<void> {
    const key = `${spec.kind}:${spec.id}`
    if (this.running.has(key)) {
      if (spec.overlap === 'queue') this.queued.set(key, { spec, opts })
      return
    }
    if (!opts.manual && this.paused) return
    const spentToday = this.spentToday(spec.id)
    if (spentToday >= spec.budget.day_usd) {
      this.broadcast({ type: 'automation.error', kind: spec.kind, id: spec.id, message: `orcamento diario esgotado: ${spentToday.toFixed(4)} USD` })
      return
    }
    this.running.add(key)
    const runId = randomUUID()
    const automationRunId = randomUUID()
    try {
      const session = this.runtime.store.create(spec.agent, spec.workspace, opts.title, spec.kind)
      this.db
        .prepare('INSERT INTO automation_runs (id, kind, automation_id, session_id, run_id, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(automationRunId, spec.kind, spec.id, session.id, runId, Date.now(), 'running')
      opts.onStarted?.(session.id, runId)
      this.broadcast({ type: 'automation.started', kind: spec.kind, id: spec.id, session_id: session.id, run_id: runId })
      const result = await this.runtime.run({
        sessionId: session.id,
        text: spec.prompt,
        runId,
        policyOverride: spec.mode === 'draft' ? draftPolicy : undefined,
        budgetOverride: { runUsd: spec.budget.run_usd },
        emit: (event) => {
          const seq = this.runtime.store.appendEvent(session.id, runId, event)
          this.broadcast({ type: 'event', session_id: session.id, run_id: runId, seq, event })
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
      this.db
        .prepare('UPDATE automation_runs SET finished_at = ?, status = ?, cost_usd = ? WHERE id = ?')
        .run(Date.now(), result.stop, result.costUsd, automationRunId)
      this.broadcast({ type: 'automation.finished', kind: spec.kind, id: spec.id, session_id: session.id, run_id: runId, stop: result.stop, cost_usd: result.costUsd })
      void this.runtime.hooks.emit('automation.finished', { kind: spec.kind, id: spec.id, session_id: session.id, run_id: runId, stop: result.stop, cost_usd: result.costUsd })
      const updated = this.runtime.store.get(session.id)
      if (updated) this.broadcast({ type: 'session.updated', session: updated })
    } catch (err) {
      this.db.prepare('UPDATE automation_runs SET finished_at = ?, status = ? WHERE id = ?').run(Date.now(), 'error', automationRunId)
      this.broadcast({ type: 'automation.error', kind: spec.kind, id: spec.id, message: describe(err) })
    } finally {
      this.running.delete(key)
      const next = this.queued.get(key)
      if (next) {
        this.queued.delete(key)
        void this.execute(next.spec, next.opts)
      }
    }
  }
}

function toAutomationRun(r: AutomationRunRow): AutomationRun {
  return {
    id: r.id,
    kind: r.kind,
    automationId: r.automation_id,
    sessionId: r.session_id,
    runId: r.run_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    costUsd: r.cost_usd,
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
