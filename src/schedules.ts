import type { Database } from 'better-sqlite3'
import { Cron } from 'croner'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScheduleSchema, type ScheduleParsed, type ScheduleSpec, type ScheduleStatus, type ServerFrame } from '@agent-hub/core'
import type { AutomationRunner } from './automation.js'
import type { Runtime } from './runtime.js'

interface ScheduleRow {
  id: string
  spec_json: string
  source: 'file' | 'db'
  last_run_at: number | null
  next_run_at: number | null
}

const tickMs = 15_000

/** Agendamentos por cron ou instante unico. A execucao em si passa pelo AutomationRunner. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly runtime: Runtime,
    private readonly db: Database,
    private readonly automation: AutomationRunner,
    private readonly broadcast: (frame: ServerFrame) => void,
  ) {}

  get paused(): boolean {
    return this.automation.paused
  }

  start(): void {
    this.loadFiles()
    this.recoverMissed()
    this.timer = setInterval(() => this.tick(), tickMs)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
    if (spec.role) this.runtime.role(spec.role)
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

  private tick(): void {
    if (this.automation.paused) return
    const now = Date.now()
    const due = this.db.prepare('SELECT * FROM schedules WHERE next_run_at IS NOT NULL AND next_run_at <= ?').all(now) as ScheduleRow[]
    for (const row of due) {
      const spec = JSON.parse(row.spec_json) as ScheduleParsed
      this.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(spec.enabled ? nextRun(spec, now) : null, spec.id)
      void this.fire(spec, false)
    }
  }

  private fire(spec: ScheduleParsed, manual: boolean): Promise<void> {
    this.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(Date.now(), spec.id)
    return this.automation.execute({ ...spec, kind: 'schedule' }, { manual, title: `[agendamento] ${spec.id}` })
  }

  private status(row: ScheduleRow): ScheduleStatus {
    const spec = JSON.parse(row.spec_json) as ScheduleSpec
    return {
      ...spec,
      source: row.source,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      running: this.automation.isRunning('schedule', row.id),
      todayUsd: this.automation.spentToday(row.id),
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
