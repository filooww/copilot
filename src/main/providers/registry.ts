import type { ModelInfo, ModelRole, ProviderConfig, Settings } from '@shared/types'
import { isLoopbackUrl, type NetGuard } from '../net/guard'
import type { SecretStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import type { ProviderAdapter, TestResult } from './adapter'
import { createAdapter } from './factory'
import { KeyPoolAdapter, parseKeys } from './pool'
import { toAppError } from './errors'
import { runStream } from './runner'
import type { ResolvedTarget } from '../session/manager'
import { solidPng } from '../util/png'

// Ollama serves '…:cloud' / '…-cloud' models from loopback but runs them on ollama.com, so the URL alone does not make them local.
export function isLocalTarget(baseUrl: string, model: string): boolean {
  return isLoopbackUrl(baseUrl) && !/[:-]cloud$/i.test(model)
}

const MODEL_TTL_MS = 10 * 60_000
const RED_PNG = solidPng(32, [220, 20, 20]).toString('base64')

export interface KeyTest {
  index: number
  ok: boolean
  error?: string
}

export interface ProviderTestReport {
  models: TestResult
  keys?: KeyTest[]
  text: { ok: boolean; ms: number | null; sample?: string; error?: string } | null
  vision: { ok: boolean; error?: string } | null
}

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>()
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>()
  readonly visionOk = new Map<string, boolean>()
  /** Last real outcome per provider/model (test or live answer): I show the LLM status green only after one succeeded. */
  readonly textOk = new Map<string, boolean>()

  constructor(
    private store: SettingsStore,
    private secrets: SecretStore,
    private guard: NetGuard
  ) {}

  list(): ProviderConfig[] {
    return this.store.providers().map((p) => {
      const keyCount = this.keyIds(p.id).length
      return { ...p, hasKey: keyCount > 0, keyCount }
    })
  }

  /** The first key keeps its original slot, so settings from before pools keep working; extra keys go to '#2', '#3'… */
  private keyIds(id: string): string[] {
    const ids: string[] = []
    for (let n = 1; this.secrets.has(n === 1 ? `provider:${id}` : `provider:${id}#${n}`); n++) ids.push(n === 1 ? `provider:${id}` : `provider:${id}#${n}`)
    return ids
  }

  private keys(id: string): string[] {
    return this.keyIds(id)
      .map((k) => this.secrets.get(k))
      .filter((k): k is string => !!k)
  }

  private setKeys(id: string, keys: string[]): void {
    for (const k of this.keyIds(id)) this.secrets.delete(k)
    keys.forEach((k, i) => this.secrets.set(i === 0 ? `provider:${id}` : `provider:${id}#${i + 1}`, k))
  }

  get(id: string): ProviderConfig | undefined {
    return this.list().find((p) => p.id === id)
  }

  /** A non-empty apiKey replaces the whole key pool; several keys may be separated by new lines. */
  upsert(cfg: ProviderConfig, apiKey?: string | null): ProviderConfig {
    const keys = apiKey ? parseKeys(apiKey) : []
    if (keys.length) this.setKeys(cfg.id, keys)
    const list = this.store.providers().filter((p) => p.id !== cfg.id)
    const { keyCount: _count, ...plain } = cfg
    this.store.saveProviders([...list, { ...plain, hasKey: this.keyIds(cfg.id).length > 0 }])
    const saved = this.get(cfg.id)!
    this.dropAdapter(cfg.id)
    this.modelCache.delete(cfg.id)
    return saved
  }

  /** A subscription has no key, so every copy is the same login; older builds let "add" create several identical rows. */
  mergeClaudeSub(roles: Settings['roles']): Settings['roles'] {
    const subs = this.store.providers().filter((p) => p.preset === 'claude-sub')
    if (subs.length < 2) return roles
    const ids = new Set(subs.map((p) => p.id))
    const keep = Object.values(roles).find((t) => t && ids.has(t.providerId))?.providerId ?? subs[0].id
    for (const id of ids) if (id !== keep) this.remove(id)
    return Object.fromEntries(Object.entries(roles).map(([r, t]) => [r, t && ids.has(t.providerId) ? { ...t, providerId: keep } : t])) as Settings['roles']
  }

  remove(id: string): void {
    for (const k of this.keyIds(id)) this.secrets.delete(k)
    this.store.saveProviders(this.store.providers().filter((p) => p.id !== id))
    this.dropAdapter(id)
    this.modelCache.delete(id)
    const roles = { ...this.store.get().roles }
    for (const k of Object.keys(roles) as ModelRole[]) if (roles[k]?.providerId === id) roles[k] = null
    this.store.patch({ roles })
  }

  private dropAdapter(id: string): void {
    this.adapters.get(id)?.release?.()
    this.adapters.delete(id)
  }

  /** Lets go of everything held for fast answers once the session is over. */
  releaseAll(): void {
    for (const a of this.adapters.values()) a.release?.()
  }

  adapter(id: string): ProviderAdapter | null {
    const cfg = this.get(id)
    if (!cfg) return null
    let a = this.adapters.get(id)
    if (!a) {
      const keys = this.keys(id)
      const make = (apiKey: string | null) => createAdapter({ cfg, apiKey, fetch: this.guard.fetch, isOffline: () => this.guard.isOffline() })
      a = keys.length > 1 ? new KeyPoolAdapter(keys.map(make)) : make(keys[0] ?? null)
      this.adapters.set(id, a)
    }
    return a
  }

  async models(id: string, refresh = false): Promise<ModelInfo[]> {
    const c = this.modelCache.get(id)
    if (c && !refresh && Date.now() - c.at < MODEL_TTL_MS) return c.models
    const a = this.adapter(id)
    if (!a) return []
    const models = await a.listModels(AbortSignal.timeout(15_000))
    this.modelCache.set(id, { at: Date.now(), models })
    return models
  }

  resolve(role: ModelRole, settings: Settings): ResolvedTarget | null {
    const t = settings.roles[role]
    if (!t?.model) return null
    const cfg = this.get(t.providerId)
    const adapter = cfg && this.adapter(cfg.id)
    if (!cfg || !adapter) return null
    return { cfg, model: t.model, adapter, isLocal: isLocalTarget(cfg.baseUrl, t.model) }
  }

  /** I use only providers the user explicitly marked as allowed fallbacks (FR-P05). */
  fallback(role: ModelRole, exclude: string, settings: Settings): ResolvedTarget | null {
    for (const r of [role, 'quick_answer', 'deep_answer'] as ModelRole[]) {
      const t = settings.roles[r]
      if (!t || t.providerId === exclude) continue
      const cfg = this.get(t.providerId)
      if (cfg?.allowFallback) {
        const adapter = this.adapter(cfg.id)
        if (adapter) return { cfg, model: t.model, adapter, isLocal: isLocalTarget(cfg.baseUrl, t.model) }
      }
    }
    return null
  }

  async test(id: string, model: string | null): Promise<ProviderTestReport> {
    const a = this.adapter(id)
    const cfg = this.get(id)
    if (!a || !cfg) return { models: { ok: false, error: { code: 'not_found', message: 'Провайдер не найден' } }, text: null, vision: null }
    const keys = a instanceof KeyPoolAdapter ? await testKeys(a) : undefined
    const t0 = Date.now()
    let models: TestResult
    let list: ModelInfo[]
    try {
      list = await this.models(id, true)
      models = { ok: true, latencyMs: Date.now() - t0, models: list.length }
    } catch (e) {
      return { models: { ok: false, error: toAppError(e) }, keys, text: null, vision: null }
    }
    if (!model) return { models, keys, text: null, vision: null }
    // Cold-loading a local model into VRAM routinely takes 20–60 s on the first request.
    const budget = isLoopbackUrl(cfg.baseUrl) ? 120_000 : 30_000
    let text: ProviderTestReport['text']
    try {
      const r = await runStream(
        a,
        { model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 64, temperature: 0 },
        AbortSignal.timeout(budget),
        { onText: () => {} },
        { timeoutMs: Math.max(cfg.timeoutMs, 20_000), retries: 1 }
      )
      text = { ok: r.text.length > 0, ms: r.firstTokenMs, sample: r.text.slice(0, 60) }
    } catch (e) {
      text = { ok: false, ms: null, error: toAppError(e).message + (toAppError(e).detail ? `: ${toAppError(e).detail}` : '') }
    }
    this.textOk.set(`${id}/${model}`, text.ok)
    let vision: ProviderTestReport['vision']
    if (list.find((m) => m.id === model)?.vision === false) {
      this.visionOk.set(`${id}/${model}`, false)
      return { models, keys, text, vision: { ok: false, error: 'Модель без поддержки изображений — для экрана будет OCR' } }
    }
    try {
      const r = await runStream(
        a,
        {
          model,
          messages: [{ role: 'user', content: 'What is the main color of this image? One word.', images: [{ mime: 'image/png', base64: RED_PNG }] }],
          maxTokens: 64,
          temperature: 0
        },
        AbortSignal.timeout(budget),
        { onText: () => {} },
        { timeoutMs: Math.max(cfg.timeoutMs, 20_000), retries: 0 }
      )
      const ok = /red|красн|червон/i.test(r.text)
      vision = ok ? { ok } : { ok, error: `Модель не распознала тестовое изображение («${r.text.slice(0, 40)}»)` }
    } catch (e) {
      vision = { ok: false, error: toAppError(e).message }
    }
    this.visionOk.set(`${id}/${model}`, vision.ok)
    return { models, keys, text, vision }
  }
}

/** I check every key of a pool separately, so one dead key doesn't hide behind the healthy ones. */
async function testKeys(pool: KeyPoolAdapter): Promise<KeyTest[]> {
  return Promise.all(
    pool.members.map(async (m, index) => {
      try {
        await m.listModels(AbortSignal.timeout(15_000))
        return { index, ok: true }
      } catch (e) {
        const err = toAppError(e)
        return { index, ok: false, error: err.message + (err.detail ? `: ${err.detail}` : '') }
      }
    })
  )
}
