import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NetGuard } from '../src/main/net/guard'
import { ProviderRegistry } from '../src/main/providers/registry'
import { SecretStore, type Cipher } from '../src/main/storage/secrets'
import { SettingsStore } from '../src/main/storage/settings'
import type { ProviderAdapter } from '../src/main/providers/adapter'
import { appError, ProviderError } from '../src/main/providers/errors'
import { KeyPoolAdapter, parseKeys } from '../src/main/providers/pool'
import type { ChatRequest, ErrorCode, ProviderConfig, StreamChunk } from '../src/shared/types'

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, temperature: 0 }

/** A fake key: answers with its name, or fails with the queued error codes first. */
function key(name: string, failures: (ErrorCode | 'mid')[] = []): ProviderAdapter & { calls: number } {
  return {
    calls: 0,
    async listModels() {
      this.calls++
      const f = failures.shift()
      if (f && f !== 'mid') throw new ProviderError(appError(f))
      return [{ id: name, vision: null }]
    },
    async *stream(): AsyncIterable<StreamChunk> {
      this.calls++
      const f = failures.shift()
      if (f === 'mid') {
        yield { type: 'text', text: 'half' }
        throw new ProviderError(appError('server'))
      }
      if (f) throw new ProviderError(appError(f))
      yield { type: 'text', text: name }
    }
  }
}

async function text(a: ProviderAdapter): Promise<string> {
  let out = ''
  for await (const c of a.stream(req, new AbortController().signal)) if (c.type === 'text') out += c.text
  return out
}

describe('KeyPoolAdapter', () => {
  it('spreads requests over keys round-robin', async () => {
    const pool = new KeyPoolAdapter([key('a'), key('b'), key('c')])
    expect([await text(pool), await text(pool), await text(pool), await text(pool)]).toEqual(['a', 'b', 'c', 'a'])
  })

  it('moves to the next key on 429 and skips the cooling key afterwards', async () => {
    let now = 1000
    const a = key('a', ['rate_limit'])
    const pool = new KeyPoolAdapter([a, key('b')], () => now)
    expect(await text(pool)).toBe('b')
    expect(pool.state()[0].reason).toBe('rate_limit')
    expect(await text(pool)).toBe('b')
    expect(a.calls).toBe(1)
    now += 61_000
    expect(await text(pool)).toBe('a')
  })

  it('cools rejected and out-of-balance keys too', async () => {
    const pool = new KeyPoolAdapter([key('a', ['auth']), key('b', ['quota']), key('c')])
    expect(await text(pool)).toBe('c')
    expect(pool.state().map((s) => s.reason)).toEqual(['auth', 'quota', null])
  })

  it('does not switch keys on server errors — the runner retries those', async () => {
    const pool = new KeyPoolAdapter([key('a', ['server']), key('b')])
    await expect(text(pool)).rejects.toThrow()
    expect(pool.state()[0].coolingUntil).toBeNull()
  })

  it('never replays on another key after output started', async () => {
    const b = key('b')
    const pool = new KeyPoolAdapter([key('a', ['mid']), b])
    await expect(text(pool)).rejects.toThrow()
    expect(b.calls).toBe(0)
  })

  it('throws the last error when every key is limited', async () => {
    const pool = new KeyPoolAdapter([key('a', ['rate_limit']), key('b', ['quota'])])
    await expect(text(pool)).rejects.toMatchObject({ appError: { code: 'quota' } })
  })

  it('fails over listModels as well', async () => {
    const pool = new KeyPoolAdapter([key('a', ['auth']), key('b')])
    expect((await pool.listModels())[0].id).toBe('b')
  })
})

describe('parseKeys', () => {
  it('splits by lines, commas and spaces and drops duplicates', () => {
    expect(parseKeys(' sk-proj-1111\nsk-proj-2222, sk-proj-3333 ;sk-proj-1111\n\n')).toEqual(['sk-proj-1111', 'sk-proj-2222', 'sk-proj-3333'])
  })

  it('drops numbering, labels and quotes pasted along with keys', () => {
    expect(parseKeys('1. AIzaSyA1b2C3\n2) "AIzaSyD4e5F6"\nКлюч: AIzaSyG7h8I9\nGemini key')).toEqual(['AIzaSyA1b2C3', 'AIzaSyD4e5F6', 'AIzaSyG7h8I9'])
  })
})

describe('ProviderRegistry key pool', () => {
  const cipher: Cipher = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }
  const cfg: ProviderConfig = {
    id: 'p1',
    label: 'OpenAI',
    preset: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    hasKey: false,
    allowFallback: false,
    timeoutMs: 12000
  }

  it('stores several keys as a pool, replaces the whole list and removes every key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'km-pool-'))
    const secrets = new SecretStore(join(dir, 'secrets.bin'), cipher)
    const reg = new ProviderRegistry(new SettingsStore(join(dir, 's.json'), join(dir, 'p.json')), secrets, new NetGuard())
    expect(reg.upsert(cfg, 'sk-key-1\nsk-key-2\nsk-key-3').keyCount).toBe(3)
    expect(reg.adapter('p1')).toBeInstanceOf(KeyPoolAdapter)
    // Saving without new keys keeps the pool.
    expect(reg.upsert({ ...cfg, label: 'renamed' }, null).keyCount).toBe(3)
    expect(reg.upsert(cfg, 'sk-key-9').keyCount).toBe(1)
    expect(secrets.has('provider:p1#2')).toBe(false)
    expect(reg.adapter('p1')).not.toBeInstanceOf(KeyPoolAdapter)
    reg.upsert(cfg, 'sk-key-1 sk-key-2')
    reg.remove('p1')
    expect(secrets.has('provider:p1')).toBe(false)
    expect(secrets.has('provider:p1#2')).toBe(false)
  })
})

describe('Gemini bad key', () => {
  it('maps 400 API_KEY_INVALID to auth so the pool skips the key', async () => {
    const { fromHttp } = await import('../src/main/providers/errors')
    const body = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })
    expect(fromHttp(400, body).appError.code).toBe('auth')
    expect(fromHttp(400, '{"error":{"message":"Invalid value at contents"}}').appError.code).toBe('bad_request')
  })
})

describe('duplicate Claude subscription rows', () => {
  const cipher: Cipher = { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() }
  const sub = (id: string): ProviderConfig => ({ id, label: 'Claude', preset: 'claude-sub', protocol: 'claude-cli', baseUrl: 'https://claude.ai', hasKey: false, allowFallback: false, timeoutMs: 30000 })

  it('keeps the row in use, repoints the roles and leaves other providers alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'km-sub-'))
    const store = new SettingsStore(join(dir, 's.json'), join(dir, 'p.json'))
    const reg = new ProviderRegistry(store, new SecretStore(join(dir, 'secrets.bin'), cipher), new NetGuard())
    reg.upsert(sub('a'), null)
    reg.upsert(sub('b'), null)
    reg.upsert(sub('c'), null)
    reg.upsert({ ...sub('g'), preset: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }, 'AIzaSyA1b2C3')
    store.patch({ roles: { quick_answer: { providerId: 'b', model: 'opus' }, deep_answer: { providerId: 'c', model: 'sonnet' }, vision: { providerId: 'g', model: 'x' } } })
    store.patch({ roles: reg.mergeClaudeSub(store.get().roles) })
    expect(reg.list().map((p) => p.id).sort()).toEqual(['b', 'g'])
    expect(store.get().roles.quick_answer).toEqual({ providerId: 'b', model: 'opus' })
    expect(store.get().roles.deep_answer).toEqual({ providerId: 'b', model: 'sonnet' })
    expect(store.get().roles.vision?.providerId).toBe('g')
  })
})
