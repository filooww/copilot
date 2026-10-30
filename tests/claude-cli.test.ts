import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeCliAdapter } from '../src/main/providers/claude-cli'
import type { ChatRequest, ProviderConfig } from '../src/shared/types'

const cfg: ProviderConfig = {
  id: 'c',
  label: 'Claude',
  preset: 'claude-sub',
  protocol: 'claude-cli',
  baseUrl: 'https://claude.ai',
  hasKey: false,
  allowFallback: false,
  timeoutMs: 30000
}
const req: ChatRequest = {
  model: 'haiku',
  messages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Вопрос' }
  ],
  maxTokens: 64,
  temperature: 0
}

/** A stand-in for the claude binary: echoes what it got and answers per scenario. */
function fakeClaude(scenario: 'ok' | 'nologin' | 'limit' | 'credits'): string {
  const dir = mkdtempSync(join(tmpdir(), 'km-claude-'))
  const bin = join(dir, 'claude')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(join(dir, 'spawned'))}, 'x')
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  const args = process.argv.slice(2)
  const msg = JSON.parse(input.trim())
  out({ type: 'system', subtype: 'init' })
  if (${JSON.stringify(scenario)} === 'nologin') return out({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })
  if (${JSON.stringify(scenario)} === 'credits') return out({ type: 'result', is_error: true, api_error_status: 429, result: 'Fable 5.1 requires usage credits. Switch to another model.' })
  if (${JSON.stringify(scenario)} === 'limit') return out({ type: 'result', is_error: true, result: "You've hit your usage limit · resets 5pm" })
  const text = msg.message.content.find((c) => c.type === 'text').text
  for (const t of ['Ответ ', text, ' ', args[args.indexOf('--model') + 1], ' key=', String(!!process.env.ANTHROPIC_API_KEY)])
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
  out({ type: 'result', is_error: false, result: 'ignored', usage: { input_tokens: 10, output_tokens: 4 } })
})
`
  )
  chmodSync(bin, 0o755)
  return bin
}

async function run(a: ClaudeCliAdapter) {
  let text = ''
  let usage = null
  for await (const c of a.stream(req, new AbortController().signal)) {
    if (c.type === 'text') text += c.text
    else usage = c
  }
  return { text, usage }
}

const adapter = (offline = false) => new ClaudeCliAdapter({ cfg, apiKey: null, fetch: fetch, isOffline: () => offline })

describe('ClaudeCliAdapter', () => {
  afterEach(() => {
    delete process.env.COPILOT_CLAUDE_BIN
    delete process.env.ANTHROPIC_API_KEY
  })

  it('streams text, passes system prompt and model, and hides API keys from the CLI', async () => {
    process.env.COPILOT_CLAUDE_BIN = fakeClaude('ok')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak'
    const r = await run(adapter())
    expect(r.text).toBe('Ответ <instructions>\nSYS\n</instructions>\n\nВопрос haiku key=false')
    expect(r.usage).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 4 })
  })

  it('answers from a warm process and tops the pool back up', async () => {
    const bin = fakeClaude('ok')
    const log = join(bin, '..', 'spawned')
    const spawned = () => (existsSync(log) ? readFileSync(log, 'utf8').length : 0)
    const waitFor = async (n: number) => {
      for (let i = 0; i < 100 && spawned() < n; i++) await new Promise((r) => setTimeout(r, 20))
    }
    process.env.COPILOT_CLAUDE_BIN = bin
    const a = adapter()
    a.prepare('haiku')
    await waitFor(2)
    expect(spawned()).toBe(2)
    expect((await run(a)).text).toContain('Вопрос')
    await waitFor(3)
    // A cold start would have made it four: the extra process plus the refill.
    expect(spawned()).toBe(3)
    a.release()
    expect((await run(a)).text).toContain('Вопрос')
    await waitFor(4)
    expect(spawned()).toBe(4)
  })

  it('does not keep processes ready in offline mode', async () => {
    const bin = fakeClaude('ok')
    process.env.COPILOT_CLAUDE_BIN = bin
    const a = adapter(true)
    a.prepare('haiku')
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(bin, '..', 'spawned'))).toBe(false)
  })

  it('reports a missing login as an auth error with a hint', async () => {
    process.env.COPILOT_CLAUDE_BIN = fakeClaude('nologin')
    await expect(run(adapter())).rejects.toMatchObject({ appError: { code: 'auth' } })
  })

  it('reports an exhausted subscription as quota', async () => {
    process.env.COPILOT_CLAUDE_BIN = fakeClaude('limit')
    await expect(run(adapter())).rejects.toMatchObject({ appError: { code: 'quota' } })
  })

  it('refuses to run in offline mode', async () => {
    process.env.COPILOT_CLAUDE_BIN = fakeClaude('ok')
    await expect(run(adapter(true))).rejects.toMatchObject({ appError: { code: 'offline_blocked' } })
  })

  it('reports a model that needs usage credits as such, not as a rate limit', async () => {
    process.env.COPILOT_CLAUDE_BIN = fakeClaude('credits')
    const a = new ClaudeCliAdapter({ cfg, apiKey: null, fetch })
    const run = async () => {
      for await (const _ of a.stream(req, new AbortController().signal)) void _
    }
    await expect(run()).rejects.toMatchObject({ appError: { code: 'quota', detail: expect.stringContaining('usage credits') } })
  })
})
