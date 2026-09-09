import { randomBytes } from 'node:crypto'

export interface OtelOptions {
  endpoint: string
  headers: Record<string, string>
  serviceName: string
  log: (message: string) => void
}

export interface SpanInput {
  name: string
  traceId: string
  startMs: number
  endMs: number
  attributes: Record<string, string | number | boolean>
  status?: 'ok' | 'error'
}

interface OtlpAttribute {
  key: string
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean }
}

interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  status: { code: number }
}

const flushMs = 5000
const maxBatch = 200

/** Exportador OTLP/HTTP em JSON, com lote e sem dependencias. Segue as convencoes semanticas de GenAI nos atributos. */
export class OtelExporter {
  private queue: OtlpSpan[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly opts: OtelOptions) {}

  span(input: SpanInput): void {
    this.queue.push({
      traceId: input.traceId,
      spanId: randomBytes(8).toString('hex'),
      name: input.name,
      kind: 3,
      startTimeUnixNano: nanos(input.startMs),
      endTimeUnixNano: nanos(input.endMs),
      attributes: Object.entries(input.attributes).map(([key, value]) => ({ key, value: attr(value) })),
      status: { code: input.status === 'error' ? 2 : 1 },
    })
    if (this.queue.length >= maxBatch) void this.flush()
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), flushMs)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const spans = this.queue.splice(0)
    if (spans.length === 0) return
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: this.opts.serviceName } }] },
          scopeSpans: [{ scope: { name: 'agent-hub' }, spans }],
        },
      ],
    })
    try {
      const res = await fetch(`${this.opts.endpoint.replace(/\/$/, '')}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) this.opts.log(`otel: HTTP ${res.status}`)
    } catch (err) {
      this.opts.log(`otel: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Converte um id de run (UUID) em trace id de 32 hex. */
export function traceIdFrom(runId: string): string {
  const hex = runId.replace(/-/g, '')
  return /^[0-9a-f]{32}$/i.test(hex) ? hex.toLowerCase() : randomBytes(16).toString('hex')
}

/** Le `k=v,k2=v2` do formato OTEL_EXPORTER_OTLP_HEADERS. */
export function parseOtelHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=')
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  return out
}

function nanos(ms: number): string {
  return `${Math.round(ms)}000000`
}

function attr(value: string | number | boolean): OtlpAttribute['value'] {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  return { stringValue: value }
}
