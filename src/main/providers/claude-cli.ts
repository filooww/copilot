import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, ErrorCode, ModelInfo, StreamChunk } from '@shared/types'
import type { AdapterDeps, ProviderAdapter } from './adapter'
import { appError, ProviderError } from './errors'

/** Claude through the official CLI and the user's login: no tools, MCP, settings or saved session. */

// A Finder-launched app gets a bare PATH.
export function claudeBin(): string | null {
  const override = process.env.COPILOT_CLAUDE_BIN
  if (override) return existsSync(override) ? override : null
  const home = homedir()
  const candidates = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.local/bin/claude'), join(home, '.claude/local/claude')]
  return candidates.find((p) => existsSync(p)) ?? null
}

// API credentials in the environment would silently switch the CLI from the subscription to paid API billing.
const STRIP_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]

export function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of STRIP_ENV) delete env[k]
  env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', env.PATH ?? ''].join(':')
  return env
}

export const CLAUDE_SUB_MODELS: ModelInfo[] = [
  { id: 'haiku', label: 'Haiku — самый быстрый', vision: true },
  { id: 'sonnet', label: 'Sonnet — быстрый и умный', vision: true },
  { id: 'opus', label: 'Opus — самый умный, медленнее', vision: true },
  { id: 'fable', label: 'Fable — флагман, может требовать usage credits', vision: true }
]

export interface ClaudeStatus {
  installed: boolean
  loggedIn: boolean
  account: string | null
  plan: string | null
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  const bin = claudeBin()
  if (!bin) return { installed: false, loggedIn: false, account: null, plan: null }
  const out = await new Promise<string>((resolve) => {
    const p = spawn(bin, ['auth', 'status', '--json'], { env: claudeEnv(), cwd: tmpdir() })
    let buf = ''
    p.stdout.on('data', (b: Buffer) => (buf += b.toString('utf8')))
    p.on('error', () => resolve(''))
    p.on('close', () => resolve(buf))
  })
  try {
    const j = JSON.parse(out) as Record<string, unknown>
    const str = (k: string) => (typeof j[k] === 'string' && j[k] ? (j[k] as string) : null)
    return { installed: true, loggedIn: j.loggedIn === true, account: str('email') ?? str('account'), plan: str('subscriptionType') ?? str('authMethod') }
  } catch {
    return { installed: true, loggedIn: false, account: null, plan: null }
  }
}

function classify(text: string, status: number | null): ErrorCode {
  const t = text.toLowerCase()
  if (status === 401 || status === 403 || /not logged in|\/login|log in|unauthori[sz]ed|oauth|token (has )?expired|invalid api key/.test(t)) return 'auth'
  if (/usage credits/.test(t)) return 'quota'
  if (/usage limit|limit reached|hit your limit|out of (extra )?usage|credit balance/.test(t)) return 'quota'
  if (status === 429 || /rate.?limit|too many requests/.test(t)) return 'rate_limit'
  if ((status !== null && status >= 500) || /overloaded|internal server error/.test(t)) return 'server'
  return 'unknown'
}

const AUTH_HINT = 'Войдите в Claude: Настройки → Провайдеры → «Войти через браузер»'

// A warm process is spawned before the question exists, so its system prompt can't carry the request's instructions; they travel in the message.
const CLI_SYSTEM = 'Follow the <instructions> block at the start of the user message exactly. You have no tools.'
// An answer starts two requests at once (say + points), so one warm process per model would leave the second one cold.
const WARM_PER_MODEL = 2
const WARM_TTL_MS = 10 * 60_000

interface CliProcess {
  proc: ChildProcessWithoutNullStreams
  at: number
  stderr: () => string
  exited: Promise<number | null>
}

function userContent(req: ChatRequest): unknown[] {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns = req.messages.filter((m) => m.role !== 'system')
  const text = turns.length === 1 ? turns[0].content : turns.map((m) => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}:\n${m.content}`).join('\n\n')
  const images = turns.flatMap((m) => m.images ?? [])
  const full = system ? `<instructions>\n${system}\n</instructions>\n\n${text}` : text
  return [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })), { type: 'text', text: full }]
}

export class ClaudeCliAdapter implements ProviderAdapter {
  private warm = new Map<string, CliProcess[]>()
  private recycle: NodeJS.Timeout | null = null

  constructor(private deps: AdapterDeps) {}

  /** Starting the CLI costs 0.5–2 s, so sessions keep processes waiting on stdin; nothing is sent until a question arrives. */
  prepare(model: string): void {
    if (!this.warm.has(model)) this.warm.set(model, [])
    this.fill(model)
    this.recycle ??= setInterval(() => this.retireStale(), 60_000)
    this.recycle.unref()
  }

  release(): void {
    if (this.recycle) clearInterval(this.recycle)
    this.recycle = null
    for (const list of this.warm.values()) for (const w of list) w.proc.kill()
    this.warm.clear()
  }

  private fill(model: string): void {
    const list = this.warm.get(model)
    if (!list || this.deps.isOffline?.() || !claudeBin()) return
    while (list.length < WARM_PER_MODEL) list.push(this.launch(model))
  }

  /** A login that changed or expired under a long-idle process would surface as an error on a live question. */
  private retireStale(): void {
    const now = Date.now()
    for (const [model, list] of this.warm) {
      for (const w of list.filter((x) => now - x.at > WARM_TTL_MS)) w.proc.kill()
      this.warm.set(
        model,
        list.filter((x) => now - x.at <= WARM_TTL_MS && x.proc.exitCode === null)
      )
      this.fill(model)
    }
  }

  private take(model: string): CliProcess | null {
    const list = this.warm.get(model)
    if (!list) return null
    let got: CliProcess | null = null
    while (list.length && !got) {
      const w = list.shift()!
      if (w.proc.exitCode === null && !w.proc.killed) got = w
    }
    this.fill(model)
    return got
  }

  private launch(model: string): CliProcess {
    const args = [
      '--print',
      '--safe-mode',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      model,
      '--effort',
      'low',
      '--system-prompt',
      CLI_SYSTEM
    ]
    // The temp dir keeps any project CLAUDE.md or settings out of the prompt.
    const proc = spawn(claudeBin()!, args, { env: claudeEnv(), cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf8')).slice(-2000)))
    // A process that dies while idle must not crash the app through an unhandled stdin error.
    proc.stdin.on('error', () => {})
    const exited = new Promise<number | null>((resolve) => {
      proc.on('error', () => resolve(-1))
      proc.on('close', (code) => resolve(code))
    })
    return { proc, at: Date.now(), stderr: () => stderr, exited }
  }

  async listModels(): Promise<ModelInfo[]> {
    this.assertOnline()
    const st = await claudeStatus()
    if (!st.installed) throw new ProviderError(appError('not_found', 'Claude Code не установлен: в Терминале выполните brew install --cask claude-code'))
    if (!st.loggedIn) throw new ProviderError(appError('auth', AUTH_HINT))
    return CLAUDE_SUB_MODELS
  }

  private assertOnline(): void {
    if (this.deps.isOffline?.()) throw new ProviderError(appError('offline_blocked', 'Claude по подписке работает через интернет'))
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.assertOnline()
    if (!claudeBin()) throw new ProviderError(appError('not_found', 'Claude Code не установлен: в Терминале выполните brew install --cask claude-code'))
    const { proc, stderr, exited } = this.take(req.model) ?? this.launch(req.model)
    const kill = () => proc.kill()
    signal.addEventListener('abort', kill)
    proc.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: userContent(req) } }) + '\n')

    let streamed = false
    let pending = ''
    try {
      for await (const buf of proc.stdout as AsyncIterable<Buffer>) {
        pending += buf.toString('utf8')
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          if (!line) continue
          let ev: {
            type?: string
            event?: { type?: string; delta?: { type?: string; text?: string } }
            is_error?: boolean
            result?: string
            api_error_status?: number | null
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
          }
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && ev.event.delta.text) {
            streamed = true
            yield { type: 'text', text: ev.event.delta.text }
          } else if (ev.type === 'result') {
            if (ev.is_error) {
              const msg = ev.result ?? 'ошибка Claude Code'
              const code = classify(msg, ev.api_error_status ?? null)
              if (/usage credits/i.test(msg))
                throw new ProviderError(
                  appError('quota', `${req.model}: на вашей подписке нужны usage credits. Выберите другую модель в Настройки → Провайдеры`)
                )
              throw new ProviderError({
                ...appError(code === 'unknown' ? 'server' : code, code === 'auth' ? `${msg}. ${AUTH_HINT}` : msg),
                status: ev.api_error_status ?? undefined
              })
            }
            if (!streamed && ev.result) yield { type: 'text', text: ev.result }
            const u = ev.usage ?? {}
            yield {
              type: 'usage',
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0
            }
            return
          }
        }
      }
      const code = await exited
      if (signal.aborted) throw new ProviderError(appError('cancelled'))
      const err = stderr()
      const kind = classify(err, null)
      throw new ProviderError(
        appError(kind === 'unknown' ? 'server' : kind, `Claude Code завершился (код ${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`)
      )
    } finally {
      signal.removeEventListener('abort', kill)
      if (proc.exitCode === null) proc.kill()
    }
  }
}

export function loginScript(bin: string): string {
  return [
    '#!/bin/zsh',
    `unset ${STRIP_ENV.join(' ')}`,
    'clear',
    'echo "Вход в Claude для Copilot. Откроется браузер — войдите в свой аккаунт Claude."',
    'echo',
    `'${bin.replace(/'/g, `'\\''`)}' auth login`,
    'echo',
    'echo "Готово. Это окно можно закрыть и вернуться в Copilot."'
  ].join('\n')
}
