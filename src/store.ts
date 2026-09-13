import type { Database } from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { Ledger, Message, Part, RunEvent, RunMode, SessionResume, SessionResumeRecord, SessionSummary } from '@agent-hub/core'

interface SessionRow {
  id: string
  agent: string
  workspace: string
  title: string
  origin: string
  pinned: number
  archived: number
  group_name: string | null
  role: string | null
  mode: string
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

  create(agent: string, workspace: string, title?: string, origin = 'user'): SessionSummary {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO sessions (id, agent, workspace, title, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, agent, workspace, title ?? 'Nova sessao', origin, now, now)
    return this.get(id)!
  }

  /** Ferramentas de MCP escolhidas para esta sessao na ultima vez que o catalogo nao coube na janela. */
  toolSet(sessionId: string): string[] | undefined {
    const row = this.db.prepare('SELECT tool_set FROM sessions WHERE id = ?').get(sessionId) as { tool_set: string | null } | undefined
    if (!row?.tool_set) return undefined
    try {
      const nomes = JSON.parse(row.tool_set) as unknown
      return Array.isArray(nomes) ? nomes.filter((n): n is string => typeof n === 'string') : undefined
    } catch {
      return undefined
    }
  }

  setToolSet(sessionId: string, names: string[]): void {
    this.db.prepare('UPDATE sessions SET tool_set = ? WHERE id = ?').run(JSON.stringify(names), sessionId)
  }

  setting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  get(id: string): SessionSummary | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? this.summarize(row) : undefined
  }

  list(limit = 50, includeArchived = false): SessionSummary[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
      .all(limit) as SessionRow[]
    return rows.map((r) => this.summarize(r))
  }

  touch(id: string, title?: string): void {
    if (title) this.db.prepare('UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?').run(Date.now(), title, id)
    else this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  /** Renomeia, fixa ou arquiva sem mexer em `updated_at`, para nao reordenar a lista. */
  update(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; agent?: string; role?: string | null; mode?: RunMode; group?: string | null }): SessionSummary | undefined {
    if (patch.role !== undefined) this.db.prepare('UPDATE sessions SET role = ? WHERE id = ?').run(patch.role, id)
    if (patch.mode !== undefined) this.db.prepare('UPDATE sessions SET mode = ? WHERE id = ?').run(patch.mode, id)
    if (patch.group !== undefined) this.db.prepare('UPDATE sessions SET group_name = ? WHERE id = ?').run(patch.group, id)
    if (patch.title !== undefined) this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(patch.title.trim().slice(0, 120) || 'Sem titulo', id)
    if (patch.agent !== undefined) this.db.prepare('UPDATE sessions SET agent = ? WHERE id = ?').run(patch.agent, id)
    if (patch.pinned !== undefined) this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(patch.pinned ? 1 : 0, id)
    if (patch.archived !== undefined) this.db.prepare('UPDATE sessions SET archived = ? WHERE id = ?').run(patch.archived ? 1 : 0, id)
    return this.get(id)
  }

  /** Aplica o mesmo ajuste a varias sessoes de uma vez. */
  updateMany(ids: string[], patch: { pinned?: boolean; archived?: boolean; group?: string | null }): SessionSummary[] {
    const tx = this.db.transaction(() => ids.map((id) => this.update(id, patch)))
    return tx().filter((s): s is SessionSummary => s !== undefined)
  }

  /** Apaga varias sessoes numa transacao so. Devolve as que realmente sairam. */
  deleteMany(ids: string[]): string[] {
    const tx = this.db.transaction(() => ids.filter((id) => this.delete(id)))
    return tx()
  }

  /** Apaga a sessao e seu historico. O ledger fica, porque o custo ja foi pago. */
  delete(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM tool_events WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM approvals WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM resumes WHERE session_id = ?').run(id)
      return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes
    })
    return tx() > 0
  }

  /** Cria uma sessao nova com o mesmo agente e workspace e copia o historico visivel ao modelo. */
  fork(id: string): SessionSummary | undefined {
    const source = this.get(id)
    if (!source) return undefined
    const copy = this.create(source.agent, source.workspace, `Copia de ${source.title}`.slice(0, 120), 'user')
    const history = this.history(id)
    if (history.length > 0) this.appendMessages(copy.id, `fork-${id}`, history)
    const ponto = this.resume(id)
    if (ponto) this.saveResume(copy.id, null, ponto.resume, ponto.text)
    return this.get(copy.id)
  }

  /** Historico que vai ao modelo: so mensagens do nivel principal, a partir da ultima compactacao. */
  history(sessionId: string): Message[] {
    const rows = this.db
      .prepare('SELECT run_id, content_json FROM messages WHERE session_id = ? AND parent_run_id IS NULL ORDER BY id')
      .all(sessionId) as { run_id: string; content_json: string }[]
    const all = rows.map((r) => ({ ...(JSON.parse(r.content_json) as Message), runId: r.run_id }))
    const lastCompaction = all.map((m, i) => (m.kind === 'compaction' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    return lastCompaction > 0 ? all.slice(lastCompaction) : all
  }

  /** Mensagens de subagentes agrupadas por run filho, para a interface aninhar nos cartoes. */
  children(sessionId: string): { runId: string; parentRunId: string; agent: string; messages: Message[] }[] {
    const rows = this.db
      .prepare('SELECT run_id, parent_run_id, agent, content_json FROM messages WHERE session_id = ? AND parent_run_id IS NOT NULL ORDER BY id')
      .all(sessionId) as { run_id: string; parent_run_id: string; agent: string | null; content_json: string }[]
    const groups = new Map<string, { runId: string; parentRunId: string; agent: string; messages: Message[] }>()
    for (const r of rows) {
      let g = groups.get(r.run_id)
      if (!g) {
        g = { runId: r.run_id, parentRunId: r.parent_run_id, agent: r.agent ?? 'subagente', messages: [] }
        groups.set(r.run_id, g)
      }
      g.messages.push(JSON.parse(r.content_json) as Message)
    }
    return [...groups.values()]
  }

  appendMessages(sessionId: string, runId: string, messages: Message[], child?: { parentRunId: string; agent: string }): void {
    const insert = this.db.prepare(
      'INSERT INTO messages (session_id, run_id, role, content_json, created_at, parent_run_id, agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const tx = this.db.transaction((items: Message[]) => {
      for (const m of items) insert.run(sessionId, runId, m.role, JSON.stringify(m), Date.now(), child?.parentRunId ?? null, child?.agent ?? null)
    })
    tx(this.dehydrate(messages))
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


  /** Runs que terminaram mal no periodo, lidos dos eventos gravados: e la que aparece a parada do run inteiro. */
  recentFailures(since: number, limit = 5): { sessionId: string; runId: string; stop: string; error?: string }[] {
    const rows = this.db
      .prepare("SELECT session_id, run_id, event_json FROM events WHERE created_at >= ? AND event_json LIKE '%run_finished%' ORDER BY seq DESC LIMIT 200")
      .all(since) as { session_id: string; run_id: string; event_json: string }[]
    const ruins = new Set(['error', 'max_output', 'budget_exceeded', 'tool_call_invalid', 'refusal'])
    const out: { sessionId: string; runId: string; stop: string; error?: string }[] = []
    for (const row of rows) {
      if (out.length >= limit) break
      try {
        const e = JSON.parse(row.event_json) as { type: string; stop?: string; error?: string }
        if (e.type !== 'run_finished' || !e.stop || !ruins.has(e.stop)) continue
        out.push({ sessionId: row.session_id, runId: row.run_id, stop: e.stop, error: e.error })
      } catch {
        continue
      }
    }
    return out
  }

  /** Guarda a imagem uma vez por conteudo e devolve o hash: a mensagem fica com a referencia, nao com o base64. */
  putMedia(mediaType: string, base64: string): string {
    const bytes = Buffer.from(base64, 'base64')
    const hash = createHash('sha256').update(bytes).digest('hex')
    this.db
      .prepare('INSERT INTO media (hash, media_type, bytes, size, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING')
      .run(hash, mediaType, bytes, bytes.length, Date.now())
    return hash
  }

  media(hash: string): { mediaType: string; bytes: Buffer } | null {
    const row = this.db.prepare('SELECT media_type, bytes FROM media WHERE hash = ?').get(hash) as { media_type: string; bytes: Buffer } | undefined
    return row ? { mediaType: row.media_type, bytes: row.bytes } : null
  }

  /** Tira o base64 das mensagens antes de gravar, deixando so a referencia. */
  private dehydrate(messages: Message[]): Message[] {
    return messages.map((m) => {
      if (!m.parts.some((p) => p.type === 'image' && p.data)) return m
      return {
        ...m,
        parts: m.parts.map((p) => {
          if (p.type !== 'image' || !p.data) return p
          const ref = this.putMedia(p.mediaType, p.data)
          const trocada: Part = { type: 'image', mediaType: p.mediaType, ref, name: p.name }
          return trocada
        }),
      }
    })
  }

  /** Devolve o base64 das imagens referenciadas, para a mensagem poder ir ao provedor. */
  hydrate(messages: Message[]): Message[] {
    return messages.map((m) => {
      if (!m.parts.some((p) => p.type === 'image' && !p.data && p.ref)) return m
      return {
        ...m,
        parts: m.parts.map((p) => {
          if (p.type !== 'image' || p.data || !p.ref) return p
          const guardada = this.media(p.ref)
          return guardada ? { ...p, data: guardada.bytes.toString('base64') } : p
        }),
      }
    })
  }
  /** Guarda o ponto de retomada da sessao, um por sessao, sempre o mais recente. */
  saveResume(sessionId: string, runId: string | null, resume: SessionResume, text: string): SessionResumeRecord {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO resumes (session_id, run_id, json, text, created_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(session_id) DO UPDATE SET run_id = excluded.run_id, json = excluded.json, text = excluded.text, created_at = excluded.created_at',
      )
      .run(sessionId, runId, JSON.stringify(resume), text, now)
    return { sessionId, runId, resume, text, createdAt: now }
  }

  resume(sessionId: string): SessionResumeRecord | null {
    const row = this.db.prepare('SELECT * FROM resumes WHERE session_id = ?').get(sessionId) as
      | { session_id: string; run_id: string | null; json: string; text: string; created_at: number }
      | undefined
    if (!row) return null
    try {
      return { sessionId: row.session_id, runId: row.run_id, resume: JSON.parse(row.json) as SessionResume, text: row.text, createdAt: row.created_at }
    } catch {
      return null
    }
  }

  private summarize(row: SessionRow): SessionSummary {
    return {
      id: row.id,
      agent: row.agent,
      workspace: row.workspace,
      title: row.title,
      origin: row.origin,
      pinned: row.pinned === 1,
      group: row.group_name,
      role: row.role,
      mode: (row.mode ?? 'normal') as RunMode,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      costUsd: this.ledger.totals({ sessionId: row.id }).costUsd,
    }
  }
}
