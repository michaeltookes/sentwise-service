# sentwise-service

The managed-inference service for **[Sentwise](https://github.com/michaeltookes/sentwise)** — a
stateless [Cloudflare Worker](https://workers.cloudflare.com/) that lets a signed-in Sentwise user
draft email through the model provider **without ever holding an API key**. It is the server half of
backlog item **56a** (account + proxy).

**Deployed:** `https://sentwise-inference.sentwise-service.workers.dev`

This repository is public on purpose. The product's core privacy promise — *your mail is never
stored on our servers and never becomes training data* — is only credible if the code that handles
your mail is readable. This is that code.

## What it does

The Sentwise Mac app sends a drafting request (your voice-profile system prompt + the message to
reply to) to this Worker with a short-lived Clerk session token. The Worker:

1. Verifies the token against Clerk's JWKS (`@clerk/backend` `verifyToken`).
2. Checks the account's 14-day trial (see below).
3. Forwards the request to the **Anthropic Messages API** using a server-held key, under Anthropic's
   zero-data-retention terms.
4. Returns the drafted text and token usage.

That's the whole job. Metering, caps, rate-limiting, and checkout are **out of scope for 56a**
(items 56b / 56c) and are marked with `TODO(56b)` / `TODO(56c)` in the source.

## Privacy design — stateless by construction

- **Nothing is stored.** There is no database, no KV, no D1, no queue. The request and response live
  in memory for the duration of one `fetch` and are then gone.
- **Nothing is logged.** The Worker never writes request or response bodies anywhere. The only
  telemetry is error *types* (e.g. `rate_limited`), never content. This is enforced in CI by
  `scripts/check-no-body-logging.sh`, which fails the build if any `console.*` call appears in
  `src/`.
- **The only persisted state** anywhere is a single timestamp — `trialStartedAt` — stored in the
  user's Clerk `privateMetadata` to enforce the trial. No mail, no drafts, no prompts.

If you want to verify the claim yourself, read the request path end to end — it is short:

```
src/index.ts      router: /healthz, /v1/me, /v1/draft
  -> src/auth.ts       verify Clerk JWT, check/init the trial (Clerk privateMetadata)
  -> src/anthropic.ts  forward to Anthropic, map the response — no logging, no storage
```

## API

### `GET /healthz`
Liveness. No auth. Returns `{ "status": "ok" }`.

### `GET /v1/me`
Requires `Authorization: Bearer <clerk-session-token>`. Returns the account for display:

```json
{ "userId": "user_...", "email": "you@example.com",
  "trial": { "startedAt": "2026-08-20T...Z", "endsAt": "2026-09-03T...Z", "active": true } }
```

Viewing your account never starts the trial — the trial begins on your first real draft.

### `POST /v1/draft`
Requires `Authorization: Bearer <clerk-session-token>`. Body mirrors the app's `LLMRequest`:

```json
{ "model": "claude-sonnet-4-6", "system": "…voice profile…",
  "messages": [{ "role": "user", "content": "…" }],
  "maxTokens": 4096, "temperature": 0.7 }
```

`model`, `maxTokens`, `temperature`, and `system` are optional (model defaults to
`claude-sonnet-4-6`). Returns `{ "text": "…", "usage": { "inputTokens": N, "outputTokens": N } }`.

On an expired trial it returns **HTTP 402** with `{ "error": { "type": "trial_expired", … } }`. All
errors are structured JSON with a stable `error.type`; the Sentwise app maps these to plain messages.

## The 14-day trial

Full-featured, enforced server-side. On the first authenticated `/v1/draft` call, the Worker stamps
`trialStartedAt` into the user's Clerk `privateMetadata`. Fourteen days later, `/v1/draft` returns
`402 trial_expired`. Paid state arrives with checkout in **56c**.

## Development

Requires Node ≥ 22 (`.nvmrc`) and a Cloudflare account (Wrangler 4).

```bash
npm install
npm test           # vitest (Cloudflare Workers pool)
npm run typecheck
npm run gen-dev-vars   # writes .dev.vars from ~/.config/sentwise-service/.env (gitignored)
npm run dev            # wrangler dev
```

### Secrets

Secrets live in `~/.config/sentwise-service/.env` and are **never** committed:

- `CLERK_SECRET_KEY` — Clerk backend key (JWT verification + trial metadata).
- `ANTHROPIC_API_KEY` — the server-held drafting key.
- `CLERK_PUBLISHABLE_KEY` — public; committed in `wrangler.jsonc` as a plain var.

Push them to the Worker with (values are read from the file, never printed):

```bash
grep '^ANTHROPIC_API_KEY=' ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put ANTHROPIC_API_KEY
grep '^CLERK_SECRET_KEY='  ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put CLERK_SECRET_KEY
```

### Deploy

```bash
npm run deploy     # runs typecheck + tests first (predeploy), then wrangler deploy
```

## License

MIT — see [LICENSE](./LICENSE).
