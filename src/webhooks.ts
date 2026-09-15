import { createHmac, randomUUID } from 'node:crypto'
import type { WebhookConfig } from '@agent-hub/core'
import { standardWebhookKey } from './triggers.js'

const timeoutMs = 10_000

/** Webhooks de saida no formato Standard Webhooks, um POST por hook inscrito no evento. */
export class Webhooks {
  constructor(
    private hooks: WebhookConfig[],
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  replace(hooks: WebhookConfig[]): void {
    this.hooks = hooks
  }

  async emit(event: string, payload: Record<string, unknown>): Promise<void> {
    const targets = this.hooks.filter((h) => h.events.includes(event) || h.events.includes('*'))
    if (targets.length === 0) return
    const body = JSON.stringify({ type: event, timestamp: new Date().toISOString(), data: payload })
    await Promise.all(targets.map((h) => this.deliver(h, body)))
  }

  private async deliver(hook: WebhookConfig, body: string): Promise<void> {
    const secret = this.env[hook.secret_ref.slice(1)]
    if (!secret) {
      this.log(`webhook ${hook.name}: variável ${hook.secret_ref} não definida`)
      return
    }
    const id = `msg_${randomUUID()}`
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = createHmac('sha256', standardWebhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${signature}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) this.log(`webhook ${hook.name}: HTTP ${res.status}`)
    } catch (err) {
      this.log(`webhook ${hook.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
