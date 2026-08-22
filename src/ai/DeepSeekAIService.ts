// DeepSeek-backed AIService. Implements the same StudentAIService interface as
// ClaudeAIService (it extends it and swaps only the transport), but speaks the
// OpenAI-style chat-completions API. `deepseek-chat` is the non-reasoning model,
// so small requests return fast and cheap - no "thinking"/reasoning step runs, and
// no effort/reasoning toggle is needed because we deliberately use the
// non-reasoning model.
//
// Like ClaudeAIService, ANY failure (bad key, network, malformed reply) falls back
// to the mock, so the app never breaks in front of a class. The key lives only in
// the server environment.

import { ClaudeAIService } from './ClaudeAIService';

const DEFAULT_BASE = 'https://api.deepseek.com';

export interface DeepSeekAIServiceOptions {
  apiKey: string;
  /** Defaults to `deepseek-chat` - the cheap, non-reasoning model. */
  model?: string;
  baseUrl?: string;
  /** Injectable so the runnable check can stub the network. */
  fetchImpl?: typeof fetch;
}

export class DeepSeekAIService extends ClaudeAIService {
  private readonly baseUrl: string;

  constructor(options: DeepSeekAIServiceOptions) {
    super({
      apiKey: options.apiKey,
      model: options.model?.trim() || 'deepseek-chat',
      fetchImpl: options.fetchImpl,
    });
    this.baseUrl = (options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  protected override async text(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek API ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('no text in response');
    return text;
  }
}
