# MELDA — Backend

The service that owns MELDA's shared class dataset and proxies its AI. When the teacher and student surfaces became separate apps, something had to hold the state they share and the key they must not — this is it.

**Express 5 + Drizzle + JWT over Postgres**, with **PGlite (Postgres compiled to WASM, in-process) as the zero-setup default** — so it clones and runs with no Docker and no external database.

## What it does

- Owns the class `Dataset` (identity, tenancy, concepts, lessons, assignments, submissions, signals) in Postgres.
- **Reads reassemble the `Dataset`** (`loadDataset`) and run the **same pure functions** from [melda-shared](https://github.com/David3Emmanuel/melda-shared) the app used to call in-process (`classSummary`, `conceptDetail`, `assignmentProgress`, …), so the API's numbers can't drift from the checks.
- **Grades submissions server-side** and strips the answer key before a paper reaches a student.
- **Proxies the four AI calls** — the Anthropic key lives here and only here.
- Enforces tenancy per route: `requireAuth` → `requireRole` → class membership.

MELDA never asks the model for a number: every figure is computed by the deterministic aggregation; the AI only drafts and narrates.

## Running

```bash
pnpm install
pnpm dev        # tsx watch (auto-reload); or `pnpm start`
```

That's the whole setup. On boot the server runs migrations and, if the database is empty, **seeds the demo class**, then prints the demo logins. It listens on `:4000` (override with `PORT`).

By default it uses **PGlite** and persists to `.melda-pglite` (delete that folder to reset). To use a real Postgres — same schema, same SQL — set `DATABASE_URL`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/melda pnpm start
```

Copy [.env.example](.env.example) to `.env` for the rest (`JWT_SECRET`, `ALLOWED_ORIGINS`, and the optional `ANTHROPIC_API_KEY`).

### Demo logins (seeded)

| Role    | Email                                 | Password |
| ------- | ------------------------------------- | -------- |
| Teacher | `teacher@melda.africa`                | `melda`  |
| Student | `s1@melda.africa` (any seeded `s`-id) | `melda`  |

The seed reproduces **"…% struggled with Ionic Bonding"** from a deterministic class (Grade 10 Chemistry, 25 students, 7 concepts). Re-seed anytime with `pnpm db:seed`, or `POST /classes/:id/reset` (dev only).

## The API

All JSON. Everything past `/auth` requires `Authorization: Bearer <jwt>`.

- **Auth:** `POST /auth/signup`, `POST /auth/login` (`{ email, password, role }`)
- **Classes:** `GET /me/classes`
- **Teacher UNDERSTAND:** `GET /classes/:id/insights`, `/classes/:id/concepts/:conceptId`, `/classes/:id/students/:studentId`
- **Lessons / assignments:** `GET /classes/:id/lessons`, `/lessons/:id`, `/classes/:id/assignments`, `/assignments/:id` — students receive only published lessons and their own paper, **answer key stripped**
- **Teacher CREATE:** `POST /classes/:id/lessons`, `/lessons/:id/adaptations`, `/lessons/:id/publish`, `/classes/:id/assignments`
- **Student EXPERIENCE:** `POST /assignments/:id/submissions` (graded server-side), `POST /signals`
- **AI proxy (teacher-only):** `POST /ai/draft-lesson`, `/ai/draft-quiz`, `/ai/adapt-section`
- **Ops:** `GET /health`, `POST /classes/:id/reset` (dev only)

## AI

**Mock by default** — deterministic, offline, no key. Set `ANTHROPIC_API_KEY` (optionally `ANTHROPIC_MODEL`) to turn on **real Claude**, called over `fetch` (no SDK). Any failure — no key, no network, a malformed reply — **falls back to the mock**, so a demo never breaks. The key never leaves the server.

## Security

CORS locked to `ALLOWED_ORIGINS`; JSON body capped at 100kb; rate limits on `/auth` and `/ai` (the abusable surfaces); **zod** validation at every route boundary; **bcrypt** password hashes; JWT sessions; login uses a constant-time dummy compare to blunt user-enumeration by timing. Set a real `JWT_SECRET` in production. **Ceiling:** bcrypt, not argon2id (the stronger upgrade); the reset endpoint is disabled when `NODE_ENV=production`.

## Checks (assert-based, no framework)

```bash
pnpm check      # ai + claude (network stubbed) + auth + loadDataset + full API
pnpm typecheck
```

`check:api` spins the app on an ephemeral PGlite database and drives login → reads → a student submission → asserts the **insights delta** (the headline moves). `check:dataset` pins that `loadDataset` over seeded rows reproduces the `melda-shared` seed exactly.

## Layout

- `src/db/` — `schema.ts`, `client.ts` (PGlite / Postgres), `loadDataset.ts` (rows → `Dataset`), `mutations.ts` (writes: mint ids, resolve concepts), `seed.ts`
- `src/http/` — `routes.ts`, `auth.ts` (hash/verify, JWT, tenancy middleware), `schemas.ts` (zod)
- `src/ai/` — `MockAIService`, `ClaudeAIService`, `index.ts` (chosen by key presence)
- `src/server.ts` — assembly, hardening, lifecycle (`ready()` = migrate + seed-if-empty)
- `drizzle/` — generated migrations

## The four repos

- **[melda-backend](https://github.com/David3Emmanuel/melda-backend)** — this service; owns the data, proxies AI
- **[melda-shared](https://github.com/David3Emmanuel/melda-shared)** — pure domain types, aggregation logic, and REST DTOs
- **[melda-teacher](https://github.com/David3Emmanuel/melda-teacher)** — teacher app (CREATE + UNDERSTAND)
- **[melda-student](https://github.com/David3Emmanuel/melda-student)** — student app (EXPERIENCE)
