import type { Database } from 'better-sqlite3'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SecretInfo {
  name: string
  hint: string
  length: number
  updatedAt: number
  source: 'db' | 'env'
}

const nameRule = /^[A-Z][A-Z0-9_]{1,63}$/
const knownNames = ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']

/** Segredos cadastrados pela interface: AES-256-GCM no SQLite com chave local em `~/.agent-hub/secrets.key`. */
export class SecretStore {
  private readonly key: Buffer

  constructor(
    home: string,
    private readonly db: Database,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.key = loadOrCreateKey(join(home, 'secrets.key'))
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        value_enc BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  /** Injeta os segredos do banco no ambiente do processo. O banco vence variaveis vazias e perde para variaveis ja definidas. */
  applyToEnv(): string[] {
    const applied: string[] = []
    for (const row of this.rows()) {
      if (this.env[row.name] === undefined || this.env[row.name] === '') {
        this.env[row.name] = this.decrypt(row)
        applied.push(row.name)
      }
    }
    return applied
  }

  set(name: string, value: string): void {
    if (!nameRule.test(name)) throw new Error('nome inválido: use MAIÚSCULAS, dígitos e sublinhado')
    if (value.trim() === '') throw new Error('valor vazio')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(value.trim(), 'utf8'), cipher.final()])
    this.db
      .prepare(
        `INSERT INTO secrets (name, iv, tag, value_enc, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      )
      .run(name, iv, cipher.getAuthTag(), enc, Date.now())
    this.env[name] = value.trim()
  }

  /** Valor de um segredo pelo nome, do banco ou do ambiente, para uso interno do daemon. */
  get(name: string): string | undefined {
    const row = this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as { iv: Buffer; tag: Buffer; value_enc: Buffer } | undefined
    if (row) return this.decrypt(row)
    return this.env[name] || undefined
  }

  delete(name: string): boolean {
    const changes = this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes
    if (changes > 0) delete this.env[name]
    return changes > 0
  }

  /** Cifra um valor com a chave local sem cadastrar como segredo nem expor no ambiente do processo. */
  seal(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.')
  }

  unseal(sealed: string): string {
    const [iv, tag, enc] = sealed.split('.').map((p) => Buffer.from(p, 'base64'))
    return this.decrypt({ iv: iv!, tag: tag!, value_enc: enc! })
  }

  /** Lista sem revelar valores: nome, tamanho, ultimos quatro caracteres e origem. */
  list(): SecretInfo[] {
    const fromDb = new Map<string, SecretInfo>()
    for (const row of this.rows()) {
      const value = this.decrypt(row)
      fromDb.set(row.name, { name: row.name, hint: value.slice(-4), length: value.length, updatedAt: row.updated_at, source: 'db' })
    }
    const out = [...fromDb.values()]
    for (const name of knownNames) {
      const value = this.env[name]
      if (!fromDb.has(name) && value) out.push({ name, hint: value.slice(-4), length: value.length, updatedAt: 0, source: 'env' })
      if (!fromDb.has(name) && !value) out.push({ name, hint: '', length: 0, updatedAt: 0, source: 'env' })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  private rows(): { name: string; iv: Buffer; tag: Buffer; value_enc: Buffer; updated_at: number }[] {
    return this.db.prepare('SELECT * FROM secrets ORDER BY name').all() as { name: string; iv: Buffer; tag: Buffer; value_enc: Buffer; updated_at: number }[]
  }

  private decrypt(row: { iv: Buffer; tag: Buffer; value_enc: Buffer }): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, row.iv)
    decipher.setAuthTag(row.tag)
    return Buffer.concat([decipher.update(row.value_enc), decipher.final()]).toString('utf8')
  }
}

function loadOrCreateKey(file: string): Buffer {
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
  const key = randomBytes(32)
  writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  chmodSync(file, 0o600)
  return key
}
