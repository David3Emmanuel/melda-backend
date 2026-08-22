// The swap point. Every AI route imports `ai` from here, so choosing the real
// provider vs the mock happens once, in this file, and nothing else changes.
//
// Put a key in the backend's .env (git-ignored) to go live:
//   DEEPSEEK_API_KEY=sk-...            # DeepSeek (cheapest, non-reasoning default)
//   DEEPSEEK_MODEL=deepseek-chat       # optional
//   DEEPSEEK_BASE_URL=https://api.deepseek.com  # optional
//   ANTHROPIC_API_KEY=sk-ant-...       # Claude (used when no DeepSeek key)
//   ANTHROPIC_MODEL=claude-sonnet-5    # optional
//   ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional (relays e.g. agentrouter.org)
// With no key we stay on the deterministic mock, so the whole stack runs offline.
// The key lives only in the server environment - it never reaches either app.

import 'dotenv/config';
import { ClaudeAIService } from './ClaudeAIService';
import { DeepSeekAIService } from './DeepSeekAIService';
import { MockAIService } from './MockAIService';
import type { StudentAIService } from './student';

// Pick the live provider from whichever key is set; with no key we stay on the
// deterministic mock so the whole stack runs offline. DeepSeek is preferred when
// both keys are present (its default model is the cheapest, non-reasoning one).
const deepseekKey = process.env.DEEPSEEK_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

export const ai: StudentAIService = deepseekKey
  ? new DeepSeekAIService({
      apiKey: deepseekKey,
      model: process.env.DEEPSEEK_MODEL,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
    })
  : anthropicKey
    ? new ClaudeAIService({
        apiKey: anthropicKey,
        model: process.env.ANTHROPIC_MODEL,
      })
    : new MockAIService({ latencyMs: 450 });
