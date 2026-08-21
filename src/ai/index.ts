// The swap point. Every AI route imports `ai` from here, so choosing the real
// model vs the mock happens once, in this file, and nothing else changes.
//
// Put a key in the backend's .env (git-ignored) to go live:
//   ANTHROPIC_API_KEY=sk-ant-...
//   ANTHROPIC_MODEL=claude-sonnet-5   # optional
// With no key we stay on the deterministic mock, so the whole stack runs offline.
// The key lives only in the server environment - it never reaches either app.

import 'dotenv/config';
import { ClaudeAIService } from './ClaudeAIService';
import { MockAIService } from './MockAIService';
import type { StudentAIService } from './student';

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL;

export const ai: StudentAIService = apiKey
  ? new ClaudeAIService({ apiKey, model })
  : new MockAIService({ latencyMs: 450 });
