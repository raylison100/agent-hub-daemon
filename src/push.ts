import type { Database } from 'better-sqlite3'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import webpush, { type PushSubscription } from 'web-push'

interface VapidKeys {
  publicKey: string
  privateKey: string
}

export interface PushPayload {
  title: string
  body: string
  url?: string
  tag?: string
}

/** Notificacoes push do PWA: chaves VAPID por instalacao, assinaturas no SQLite e envio com limpeza de endpoints mortos. */
export class PushService {
  private readonly keys: VapidKeys

  constructor(
    home: string,
    private readonly db: Database,
    private readonly log: (message: string) => void,
    subject = 'mailto:agent-hub@localhost',
  ) {
    this.keys = loadOrCreateKeys(join(home, 'vapid.json'))
    webpush.setVapidDetails(subject, this.keys.publicKey, this.keys.privateKey)
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        subscription_json TEXT NOT NULL,
        client TEXT,
        created_at INTEGER NOT NULL
      );
    `)
  }

  get publicKey(): string {
    return this.keys.publicKey
  }

  subscribe(subscription: PushSubscription, client: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, subscription_json, client, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET subscription_json = excluded.subscription_json, client = excluded.client`,
      )
      .run(subscription.endpoint, JSON.stringify(subscription), client, Date.now())
  }

  unsubscribe(endpoint: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }
    return row.n
  }

  async send(payload: PushPayload): Promise<void> {
    const rows = this.db.prepare('SELECT endpoint, subscription_json FROM push_subscriptions').all() as { endpoint: string; subscription_json: string }[]
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription_json) as PushSubscription, JSON.stringify(payload), { TTL: 600 })
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) this.unsubscribe(row.endpoint)
          else this.log(`push: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
  }
}

function loadOrCreateKeys(file: string): VapidKeys {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys
  const keys = webpush.generateVAPIDKeys()
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}
