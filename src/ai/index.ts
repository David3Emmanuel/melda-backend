// The swap point. Every AI route imports `ai` from here, so choosing the provider
// vs the mock happens once, in this file, and nothing else changes.
//
// Set AI_PROVIDER explicitly ('deepseek' | 'anthropic'), or leave it unset to
// auto-detect from whichever key is present. With no key we stay on the
// deterministic mock, so the whole stack runs offline.
//
//   AI_PROVIDER=deepseek               # explicit (defaults to auto-detect)
//   DEEPSEEK_API_KEY=sk-...            # DeepSeek (cheapest, non-reasoning default)
//   DEEPSEEK_MODEL=deepseek-chat       # optional
//   DEEPSEEK_BASE_URL=https://api.deepseek.com  # optional
//   ANTHROPIC_API_KEY=sk-ant-...       # Claude
//   ANTHROPIC_MODEL=claude-sonnet-5    # optional
//   ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional (relays e.g. agentrouter.org)
//
// The key lives only in the server environment - it never reaches either app.

import 'dotenv/config';
import { ClaudeAIService } from './ClaudeAIService';
import { DeepSeekAIService } from './DeepSeekAIService';
import { MockAIService } from './MockAIService';
import type { StudentAIService } from './student';

const provider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
const deepseekKey = process.env.DEEPSEEK_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

const deepseek = () =>
  new DeepSeekAIService({
    apiKey: deepseekKey!,
    model: process.env.DEEPSEEK_MODEL,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
  });

const claude = () =>
  new ClaudeAIService({
    apiKey: anthropicKey!,
    model: process.env.ANTHROPIC_MODEL,
  });

function select(): StudentAIService {
  if (provider === 'deepseek' && deepseekKey) return deepseek();
  if ((provider === 'anthropic' || provider === 'claude') && anthropicKey) return claude();
  // No explicit provider (or its key is missing) - auto-detect by key, then mock.
  if (deepseekKey) return deepseek();
  if (anthropicKey) return claude();
  return new MockAIService({ latencyMs: 450 });
}

export const ai: StudentAIService = select();
