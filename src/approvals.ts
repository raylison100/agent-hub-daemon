import { randomUUID } from 'node:crypto'

export type ApprovalDecision = 'allow' | 'deny'

export interface ApprovalRequest {
  sessionId: string
  runId: string
  tool: string
  args: unknown
  risk: string
}

export interface PendingApproval extends ApprovalRequest {
  id: string
  expiresAt: number
}

interface Entry {
  info: PendingApproval
  resolve: (d: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

export class ApprovalQueue {
  private readonly pending = new Map<string, Entry>()

  /** Registra um pedido de aprovacao que expira em `timeoutMs` com `deny`. */
  request(req: ApprovalRequest, timeoutMs: number): { info: PendingApproval; promise: Promise<ApprovalDecision> } {
    const id = randomUUID()
    const info: PendingApproval = { ...req, id, expiresAt: Date.now() + timeoutMs }
    const promise = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(id, 'deny'), timeoutMs)
      this.pending.set(id, { info, resolve, timer })
    })
    return { info, promise }
  }

  respond(id: string, decision: ApprovalDecision): boolean {
    return this.settle(id, decision)
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((e) => e.info)
  }

  private settle(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(decision)
    return true
  }
}
