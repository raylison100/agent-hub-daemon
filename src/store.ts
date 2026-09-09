import type { Database } from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { Ledger, Message, RunEvent, SessionSummary } from '@agent-hub/core'

interface SessionRow {
  id: string
  agent: string
  workspace: string
  title: string
  created_at: number
  updated_at: number
}

export interface StoredEvent {
  seq: number
  run_id: string
  event: RunEvent
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly ledger: Ledger,
  ) {}

  create(agent: string, workspace: string, title?: string): SessionSummary {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO sessions (id, agent, workspace, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, agent, workspace, title ?? 'Nova sessao', now, now)
    return this.get(id)!
  }

  get(id: string): SessionSummary | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? this.summarize(row) : undefined
  }

  list(limit = 50): SessionSummary[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as SessionRow[]
    return rows.map((r) => this.summarize(r))
  }

  touch(id: string, title?: string): void {
    if (title) this.db.prepare('UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?').run(Date.now(), title, id)
    else this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  history(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT content_json FROM messages WHERE session_id = ? ORDER BY id')
      .all(sessionId) as { content_json: string }[]
    const all = rows.map((r) => JSON.parse(r.content_json) as Message)
    const lastCompaction = all.map((m, i) => (m.kind === 'compaction' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    return lastCompaction > 0 ? all.slice(lastCompaction) : all
  }

  appendMessages(sessionId: string, runId: string, messages: Message[]): void {
    const insert = this.db.prepare(
      'INSERT INTO messages (session_id, run_id, role, content_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    const tx = this.db.transaction((items: Message[]) => {
      for (const m of items) insert.run(sessionId, runId, m.role, JSON.stringify(m), Date.now())
    })
    tx(messages)
    this.touch(sessionId)
  }

  appendEvent(sessionId: string, runId: string, event: RunEvent): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?').get(sessionId) as { seq: number }
    const seq = row.seq + 1
    this.db
      .prepare('INSERT INTO events (session_id, run_id, seq, event_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, runId, seq, JSON.stringify(event), Date.now())
    return seq
  }

  eventsSince(sessionId: string, sinceSeq: number): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT seq, run_id, event_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, sinceSeq) as { seq: number; run_id: string; event_json: string }[]
    return rows.map((r) => ({ seq: r.seq, run_id: r.run_id, event: JSON.parse(r.event_json) as RunEvent }))
  }

  recordToolEvent(e: {
    sessionId: string
    runId: string
    name: string
    args: unknown
    decision: string
    result?: string
    isError?: boolean
    ms?: number
  }): void {
    this.db
      .prepare(
        'INSERT INTO tool_events (session_id, run_id, name, args_json, decision, result, is_error, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.sessionId, e.runId, e.name, JSON.stringify(e.args ?? {}), e.decision, e.result ?? null, e.isError ? 1 : 0, e.ms ?? null, Date.now())
  }

  recordApproval(id: string, sessionId: string, runId: string, tool: string, args: unknown): void {
    this.db
      .prepare('INSERT INTO approvals (id, session_id, run_id, tool, args_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, runId, tool, JSON.stringify(args ?? {}), Date.now())
  }

  resolveApproval(id: string, decision: string): void {
    this.db.prepare('UPDATE approvals SET decision = ?, resolved_at = ? WHERE id = ?').run(decision, Date.now(), id)
  }

  private summarize(row: SessionRow): SessionSummary {
    return {
      id: row.id,
      agent: row.agent,
      workspace: row.workspace,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      costUsd: this.ledger.totals({ sessionId: row.id }).costUsd,
    }
  }
}
