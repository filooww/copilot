import { AnthropicAdapter } from './anthropic'
import { ClaudeCliAdapter } from './claude-cli'
import type { AdapterDeps, ProviderAdapter } from './adapter'
import { GeminiAdapter } from './gemini'
import { OpenAiAdapter } from './openai'

export function createAdapter(deps: AdapterDeps): ProviderAdapter {
  switch (deps.cfg.protocol) {
    case 'anthropic':
      return new AnthropicAdapter(deps)
    case 'claude-cli':
      return new ClaudeCliAdapter(deps)
    case 'gemini':
      return new GeminiAdapter(deps)
    default:
      return new OpenAiAdapter(deps)
  }
}
