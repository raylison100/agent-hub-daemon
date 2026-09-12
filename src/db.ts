import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Ledger } from '@agent-hub/core'

/** Abre o SQLite do daemon em modo WAL e aplica as migracoes. */
export function openDb(path: string): DatabaseType {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  addColumn(db, 'sessions', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'sessions', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  addColumn(db, 'sessions', 'mode', "TEXT NOT NULL DEFAULT 'normal'")
  addColumn(db, 'sessions', 'group_name', 'TEXT')
  addColumn(db, 'sessions', 'role', 'TEXT')
  addColumn(db, 'runs', 'role', 'TEXT')
  addColumn(db, 'messages', 'parent_run_id', 'TEXT')
  addColumn(db, 'messages', 'agent', 'TEXT')
  Ledger.migrate(db)
  return db
}

function addColumn(db: DatabaseType, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      workspace TEXT NOT NULL,
      title TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      decision TEXT NOT NULL,
      result TEXT,
      is_error INTEGER NOT NULL DEFAULT 0,
      ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      decision TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      spec_json TEXT NOT NULL,
      source TEXT NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      automation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS automation_runs_id_ts ON automation_runs(automation_id, started_at);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      context_json TEXT NOT NULL,
      next_step TEXT,
      status TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS resumes (
      session_id TEXT PRIMARY KEY,
      run_id TEXT,
      json TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      intent TEXT,
      routed_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      intent TEXT,
      verdict TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_agent ON feedback(agent, intent);
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      spec_json TEXT NOT NULL,
      source TEXT NOT NULL,
      last_fired_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS trigger_deliveries (
      trigger_id TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      session_id TEXT,
      PRIMARY KEY (trigger_id, delivery_key)
    );
  `)
}
