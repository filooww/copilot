import type { ChatRequest, ErrorCode, ModelInfo, StreamChunk } from '@shared/types'
import type { ProviderAdapter } from './adapter'
import { toAppError } from './errors'

// How long a key sits out after the provider rejects it. Server/network errors are not the key's fault, so they never cool it.
const COOLDOWN_MS: Partial<Record<ErrorCode, number>> = {
  rate_limit: 60_000,
  quota: 30 * 60_000,
  auth: 24 * 60 * 60_000
}

export interface PoolKeyState {
  index: number
  coolingUntil: number | null
  reason: ErrorCode | null
}

/** Round-robin over several API keys; a limited, empty or rejected key is skipped before the first token. */
export class KeyPoolAdapter implements ProviderAdapter {
  private next = 0
  private until: number[]
  private reason: (ErrorCode | null)[]

  constructor(
    readonly members: ProviderAdapter[],
    private now: () => number = Date.now
  ) {
    this.until = members.map(() => 0)
    this.reason = members.map(() => null)
  }

  state(): PoolKeyState[] {
    const t = this.now()
    return this.members.map((_, i) => ({ index: i, coolingUntil: this.until[i] > t ? this.until[i] : null, reason: this.until[i] > t ? this.reason[i] : null }))
  }

  /** Healthy keys starting from the round-robin cursor; if every key is cooling, all of them — a limit may have lifted early. */
  private order(): number[] {
    const n = this.members.length
    const start = this.next
    this.next = (start + 1) % n
    const all = Array.from({ length: n }, (_, k) => (start + k) % n)
    const t = this.now()
    const ready = all.filter((i) => this.until[i] <= t)
    return ready.length ? ready : all
  }

  private cool(i: number, e: unknown): boolean {
    const err = toAppError(e)
    const ms = COOLDOWN_MS[err.code]
    if (ms === undefined) return false
    this.until[i] = this.now() + (err.code === 'rate_limit' && err.retryAfterMs ? err.retryAfterMs : ms)
    this.reason[i] = err.code
    return true
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let last: unknown
    for (const i of this.order()) {
      try {
        return await this.members[i].listModels(signal)
      } catch (e) {
        if (!this.cool(i, e)) throw e
        last = e
      }
    }
    throw last
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    let last: unknown
    for (const i of this.order()) {
      let started = false
      try {
        for await (const chunk of this.members[i].stream(req, signal)) {
          started = true
          yield chunk
        }
        return
      } catch (e) {
        // After output started, switching keys would show a second answer; the runner reports the break instead.
        if (started || signal.aborted || !this.cool(i, e)) throw e
        last = e
      }
    }
    throw last
  }
}

/** One key per line or separated by commas, semicolons or spaces; pasted numbering, labels and quotes are dropped. */
export function parseKeys(raw: string): string[] {
  const tokens = raw.split(/[\s,;]+/).map((k) => k.trim().replace(/^["'`]+|["'`]+$/g, ''))
  return [...new Set(tokens.filter((k) => k.length >= 8 && /^[A-Za-z0-9_\-.:=+/]+$/.test(k) && /\d/.test(k)))]
}
