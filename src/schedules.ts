import type { Database } from 'better-sqlite3'
import { Cron } from 'croner'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScheduleSchema, type AutomationRun, type ScheduleParsed, type ScheduleSpec, type ScheduleStatus, type ServerFrame } from '@agent-hub/core'
import { draftPolicy, type Runtime } from './runtime.js'

interface ScheduleRow {
  id: string
  spec_json: string
  source: 'file' | 'db'
  last_run_at: number | null
  next_run_at: number | null
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

const tickMs = 15_000
const pausedKey = 'automation.paused'

/** Agendamentos por cron ou instante unico, com orcamento obrigatorio, modo rascunho e interruptor geral. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private readonly running = new Set<string>()
  private readonly queued = new Set<string>()
  paused: boolean

  constructor(
    private readonly runtime: Runtime,
    private readonly db: Database,
    private readonly broadcast: (frame: ServerFrame) => void,
  ) {
    this.paused = runtime.store.setting(pausedKey) === '1'
  }

  start(): void {
    this.loadFiles()
    this.recoverMissed()
    this.timer = setInterval(() => void this.tick(), tickMs)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.runtime.store.setSetting(pausedKey, paused ? '1' : '0')
    this.broadcast({ type: 'automation.state', paused })
  }

  list(): ScheduleStatus[] {
    const rows = this.db.prepare('SELECT * FROM schedules ORDER BY id').all() as ScheduleRow[]
    return rows.map((r) => this.status(r))
  }

  get(id: string): ScheduleStatus | undefined {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined
    return row ? this.status(row) : undefined
  }

  upsert(input: unknown, source: 'file' | 'db' = 'db'): ScheduleStatus {
    const spec = ScheduleSchema.parse(input)
    this.runtime.profile(spec.agent)
    this.runtime.assertWorkspace(spec.workspace)
    const next = spec.enabled ? nextRun(spec, Date.now()) : null
    this.db
      .prepare(
        `INSERT INTO schedules (id, spec_json, source, next_run_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET spec_json = excluded.spec_json, source = excluded.source, next_run_at = excluded.next_run_at`,
      )
      .run(spec.id, JSON.stringify(spec), source, next)
    const status = this.get(spec.id)!
    this.broadcast({ type: 'schedule.saved', schedule: status })
    return status
  }

  delete(id: string): boolean {
    const changes = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes
    if (changes > 0) this.broadcast({ type: 'schedule.deleted', id })
    return changes > 0
  }

  async runNow(id: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined
    if (!row) throw new Error(`agendamento nao encontrado: ${id}`)
    await this.fire(JSON.parse(row.spec_json) as ScheduleParsed, true)
  }

  runs(automationId?: string, limit = 50): AutomationRun[] {
    const rows = (
      automationId
        ? this.db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?').all(automationId, limit)
        : this.db.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as AutomationRunRow[]
    return rows.map(toAutomationRun)
  }

  private loadFiles(): void {
    const dir = join(this.runtime.config.agentsDir, 'schedules')
    if (!existsSync(dir)) return
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        this.upsert(JSON.parse(readFileSync(join(dir, file), 'utf8')), 'file')
      } catch (err) {
        this.broadcast({ type: 'automation.error', kind: 'schedule', id: file, message: describe(err) })
      }
    }
  }

  private recoverMissed(): void {
    const now = Date.now()
    for (const row of this.db.prepare('SELECT * FROM schedules').all() as ScheduleRow[]) {
      const spec = JSON.parse(row.spec_json) as ScheduleParsed
      if (!spec.enabled || row.next_run_at === null || row.next_run_at > now) continue
      if (spec.missed === 'run_once') continue
      this.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(nextRun(spec, now), spec.id)
    }
  }

  private async tick(): Promise<void> {
    if (this.paused) return
    const now = Date.now()
    const due = this.db
      .prepare('SELECT * FROM schedules WHERE next_run_at IS NOT NULL AND next_run_at <= ?')
      .all(now) as ScheduleRow[]
    for (const row of due) {
      const spec = JSON.parse(row.spec_json) as ScheduleParsed
      this.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(spec.enabled ? nextRun(spec, now) : null, spec.id)
      void this.fire(spec, false)
    }
  }

  private async fire(spec: ScheduleParsed, manual: boolean): Promise<void> {
    if (this.running.has(spec.id)) {
      if (spec.overlap === 'queue') this.queued.add(spec.id)
      return
    }
    if (!manual && this.paused) return
    const spentToday = this.spentToday(spec.id)
    if (spentToday >= spec.budget.day_usd) {
      this.broadcast({ type: 'automation.error', kind: 'schedule', id: spec.id, message: `orcamento diario esgotado: ${spentToday.toFixed(4)} USD` })
      return
    }
    this.running.add(spec.id)
    const runId = randomUUID()
    const automationRunId = randomUUID()
    try {
      const session = this.runtime.store.create(spec.agent, spec.workspace, `[agendamento] ${spec.id}`, 'schedule')
      this.db
        .prepare('INSERT INTO automation_runs (id, kind, automation_id, session_id, run_id, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(automationRunId, 'schedule', spec.id, session.id, runId, Date.now(), 'running')
      this.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(Date.now(), spec.id)
      this.broadcast({ type: 'automation.started', kind: 'schedule', id: spec.id, session_id: session.id, run_id: runId })
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
      this.broadcast({ type: 'automation.finished', kind: 'schedule', id: spec.id, session_id: session.id, run_id: runId, stop: result.stop, cost_usd: result.costUsd })
      const updated = this.runtime.store.get(session.id)
      if (updated) this.broadcast({ type: 'session.updated', session: updated })
    } catch (err) {
      this.db.prepare('UPDATE automation_runs SET finished_at = ?, status = ? WHERE id = ?').run(Date.now(), 'error', automationRunId)
      this.broadcast({ type: 'automation.error', kind: 'schedule', id: spec.id, message: describe(err) })
    } finally {
      this.running.delete(spec.id)
      if (this.queued.delete(spec.id)) void this.fire(spec, false)
    }
  }

  private spentToday(id: string): number {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM automation_runs WHERE automation_id = ? AND started_at >= ?')
      .get(id, start.getTime()) as { total: number }
    return row.total
  }

  private status(row: ScheduleRow): ScheduleStatus {
    const spec = JSON.parse(row.spec_json) as ScheduleSpec
    return {
      ...spec,
      source: row.source,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      running: this.running.has(row.id),
      todayUsd: this.spentToday(row.id),
    }
  }
}

/** Proximo disparo em ms: pelo cron no fuso indicado, ou o instante unico se ainda estiver no futuro. */
export function nextRun(spec: Pick<ScheduleParsed, 'cron' | 'at' | 'timezone'>, from: number): number | null {
  if (spec.at !== undefined) return spec.at > from ? spec.at : null
  if (!spec.cron) return null
  const next = new Cron(spec.cron, { timezone: spec.timezone }).nextRun(new Date(from))
  return next ? next.getTime() : null
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
