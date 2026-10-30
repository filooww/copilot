import type { AppError, ChatRequest, ModelInfo, ProviderConfig, StreamChunk } from '@shared/types'

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AdapterDeps {
  cfg: ProviderConfig
  apiKey: string | null
  fetch: FetchFn
  /** For providers that reach the network outside NetGuard.fetch (a CLI subprocess). */
  isOffline?: () => boolean
}

export interface ProviderAdapter {
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  /** Throws ProviderError. Retries belong to RequestRunner, so they never happen after the first token. */
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk>
  prepare?(model: string): void
  release?(): void
}

export type TestResult = { ok: true; latencyMs: number; models: number } | { ok: false; error: AppError }

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}
