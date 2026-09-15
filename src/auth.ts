import type { Database } from 'better-sqlite3'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

export interface DeviceInfo {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
}

const senhaKey = 'auth.password'
const minimo = 8

/**
 * Senha e credencial por dispositivo, para acesso remoto. O token do daemon continua valendo na propria
 * maquina; de fora, o caminho e entrar com a senha uma vez e guardar a credencial, que voce revoga quando quiser.
 */
export class AuthStore {
  private readonly falhas = new Map<string, { contagem: number; ate: number }>()

  constructor(private readonly db: Database) {}

  temSenha(): boolean {
    return this.lerSenha() !== null
  }

  /** Define ou troca a senha do acesso remoto. Sem senha definida, nenhum dispositivo novo entra. */
  definirSenha(nova: string): void {
    if (nova.trim().length < minimo) throw new Error(`a senha precisa de pelo menos ${minimo} caracteres`)
    const salt = randomBytes(16).toString('hex')
    const hash = scryptSync(nova.trim(), salt, 64).toString('hex')
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(senhaKey, `scrypt$${salt}$${hash}`)
  }

  /** Confere a senha, com espera crescente depois de erros seguidos para nao virar alvo de tentativa em massa. */
  conferirSenha(senha: string, origem: string): boolean {
    const bloqueio = this.falhas.get(origem)
    if (bloqueio && bloqueio.ate > Date.now()) {
      throw new Error(`tentativas demais, espere ${Math.ceil((bloqueio.ate - Date.now()) / 1000)} segundos`)
    }
    const guardada = this.lerSenha()
    if (!guardada) throw new Error('nenhuma senha definida neste daemon; defina em Configurações, Conexão')
    const esperado = scryptSync(senha, guardada.salt, 64)
    const informado = Buffer.from(guardada.hash, 'hex')
    const ok = esperado.length === informado.length && timingSafeEqual(esperado, informado)
    if (ok) {
      this.falhas.delete(origem)
      return true
    }
    const contagem = (bloqueio?.contagem ?? 0) + 1
    this.falhas.set(origem, { contagem, ate: contagem >= 3 ? Date.now() + Math.min(contagem * 10_000, 300_000) : 0 })
    return false
  }

  /** Cria a credencial daquele dispositivo. O valor completo so existe aqui e no dispositivo; o banco guarda o hash. */
  criarDispositivo(name: string): { id: string; credential: string } {
    const id = randomUUID()
    const segredo = randomBytes(32).toString('hex')
    const credential = `${id}.${segredo}`
    this.db
      .prepare('INSERT INTO devices (id, name, token_hash, last_seen, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name.trim().slice(0, 60) || 'dispositivo', hashDe(segredo), null, Date.now())
    return { id, credential }
  }

  /** Confere a credencial de um dispositivo e marca o acesso. Devolve o nome quando vale. */
  conferirDispositivo(credential: string): string | null {
    const i = credential.indexOf('.')
    if (i <= 0) return null
    const id = credential.slice(0, i)
    const row = this.db.prepare('SELECT name, token_hash FROM devices WHERE id = ?').get(id) as { name: string; token_hash: string } | undefined
    if (!row) return null
    const esperado = Buffer.from(row.token_hash, 'hex')
    const informado = Buffer.from(hashDe(credential.slice(i + 1)), 'hex')
    if (esperado.length !== informado.length || !timingSafeEqual(esperado, informado)) return null
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id)
    return row.name
  }

  dispositivos(): DeviceInfo[] {
    return (this.db.prepare('SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at DESC').all() as {
      id: string
      name: string
      created_at: number | null
      last_seen: number | null
    }[]).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at ?? 0, lastSeen: r.last_seen }))
  }

  revogar(id: string): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0
  }

  private lerSenha(): { salt: string; hash: string } | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(senhaKey) as { value: string } | undefined
    if (!row) return null
    const partes = row.value.split('$')
    return partes.length === 3 && partes[0] === 'scrypt' ? { salt: partes[1]!, hash: partes[2]! } : null
  }
}

function hashDe(segredo: string): string {
  return createHash('sha256').update(segredo).digest('hex')
}
