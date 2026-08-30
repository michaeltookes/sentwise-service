# sentwise-service

The managed-inference service for **[Sentwise](https://github.com/michaeltookes/sentwise)** — a
stateless [Cloudflare Worker](https://workers.cloudflare.com/) that lets a signed-in Sentwise user
draft email through the model provider **without ever holding an API key**. It is the server half of
backlog items **56a** (account + proxy), **56b** (metering + limits), and the account-management
half of **73** (subscription display + account deletion).

**Deployed:** `https://sentwise-inference.sentwise-service.workers.dev`

This repository is public on purpose. The product's core privacy promise — _your mail is never
stored on our servers and never becomes training data_ — is only credible if the code that handles
your mail is readable. This is that code.

## What it does

The Sentwise Mac app sends a drafting request (your voice-profile system prompt + the message to
reply to) to this Worker with a short-lived Clerk session token. The Worker:

1. Verifies the token against Clerk's JWKS (`@clerk/backend` `verifyToken`).
2. Checks the account's 14-day trial (see below).
3. Forwards the request to the **Anthropic Messages API** using a server-held key, under Anthropic's
   zero-data-retention terms.
4. Returns the drafted text and token usage.

Metering, weekly caps, and rate-limiting ship in **56b** (see [Metering](#metering-56b) below).
Checkout / licensing (**56c**) is still out of scope and marked with `TODO(56c)` in the source.

## Privacy design — content-stateless by construction

- **No content is stored.** The user's mail, the prompts, and the drafted reply live in memory for
  the duration of one `fetch` and are then gone. There is no database of content, and nothing the
  user writes or receives is persisted anywhere.
- **Nothing is logged.** The Worker never writes request or response bodies anywhere. The only
  telemetry is error _types_ (e.g. `rate_limited`) and **aggregate, hashed** usage metrics, never
  content. This is enforced in CI by `scripts/check-no-body-logging.sh`, which fails the build if any
  `console.*` call appears in `src/`.
- **The only persisted state is counters, timestamps, random reservation IDs, and one hash — never
  content:**
  1. `trialStartedAt` (and, once 56c ships, `subscription`) in the user's Clerk `privateMetadata`
     (trial enforcement, 56a; subscription display, 73).
  2. Per-account **usage counters + timestamps** in a Durable Object (`AccountQuota`, 56b): the
     weekly drafts/tokens used, in-flight token reservations, a sliding rate-limit window, and random
     reservation IDs keyed by Clerk userId. No prompts, no drafts, no emails.
  3. **Aggregate, hashed usage metrics** in Workers Analytics Engine (56b): a SHA-256 hash of the
     userId (never the raw id), the model, token counts, estimated cost, latency, and outcome.
  4. **Interest flags** in the user's Clerk `privateMetadata.interest` (75): a topic key mapped to
     the ISO timestamp of the user's first click asking to be notified when a parked capability
     ships (e.g. `google-oauth`). Just a topic name + timestamp on the user's own account — no mail,
     prompt, or draft content. The maintainer reads demand by filtering Clerk users on
     `privateMetadata.interest` — there is no separate dashboard or off-account store.
- **Cloudflare invocation logs are disabled** (`observability.logs.invocation_logs: false` in
  `wrangler.jsonc`), so Cloudflare retains no per-request records — only aggregate metrics (request
  counts, error rates) with no content.
- **Account deletion removes Clerk account state and Durable Object usage state**
  (`DELETE /v1/me`, 73): the Clerk user (with `trialStartedAt` / `subscription`) and the account's
  Durable Object usage data (all usage counters, reservations, and the settlement alarm). A minimal
  DO tombstone remains so stale already-issued tokens cannot recreate fresh usage state after
  deletion. Workers Analytics Engine usage rows are retained separately as content-free,
  pseudonymous metrics keyed by a deterministic SHA-256 hash of the Clerk userId. The hash is not
  reversible by itself, but anyone who already knows the former Clerk userId can recompute it and
  find those rows. They are retained for aggregate margin/usage reporting and are not deleted by
  this endpoint.

If you want to verify the claim yourself, read the request path end to end — it is short:

```
src/index.ts      router: /healthz, GET+DELETE /v1/me, /v1/draft, POST /v1/interest, /admin/margin
  -> src/auth.ts          verify Clerk JWT, check/init the trial + read quota/subscription; delete user
  -> src/subscription.ts  derive the account's subscription (trial placeholder until 56c) — pure
  -> src/anthropic.ts     forward to Anthropic, map the response — no logging, no storage
  -> src/quota-do.ts      per-account usage counters (Durable Object) — counters only; deletion tombstone
  -> src/analytics.ts     one aggregate hashed metric per draft — no content
  -> src/interest.ts      record demand for a parked capability — a topic key + timestamp, no content
```

## API

### `GET /healthz`

Liveness. No auth. Returns `{ "status": "ok" }`.

### `GET /v1/me`

Requires `Authorization: Bearer <clerk-session-token>`. Returns the account for display:

```json
{
  "userId": "user_...",
  "email": "you@example.com",
  "trial": { "startedAt": "2026-08-20T...Z", "endsAt": "2026-09-03T...Z", "active": true },
  "subscription": {
    "plan": "trial",
    "status": "trialing",
    "renewsAt": "2026-09-03T00:00:00.000Z",
    "manageBillingUrl": null
  },
  "quota": {
    "unit": "drafts",
    "used": 12,
    "limit": 100,
    "remaining": 88,
    "resetsAt": "2026-09-07T00:00:00.000Z",
    "tokensUsed": 240000,
    "tokenLimit": 2000000,
    "enforcement": "soft",
    "extraPurchased": 0
  }
}
```

Viewing your account never starts the trial — the trial begins on your first real draft.

#### `subscription` (item 73)

The account's plan for the Settings account pane:

- `plan`: `"trial" | "individual" | "team" | "none"`
- `status`: `"trialing" | "active" | "past_due" | "canceled" | "lapsed"`
- `renewsAt`: ISO 8601 timestamp, or `null`
- `manageBillingUrl`: an `https` URL to the billing portal, or `null`

**Placeholder until 56c.** Checkout / licensing (56c) is not built yet, so today the field is
**derived from the trial** on the same Clerk `getUser` as `trial`/`quota` (no extra round-trip):

| Trial state     | `plan`  | `status`   | `renewsAt`     | `manageBillingUrl` |
| --------------- | ------- | ---------- | -------------- | ------------------ |
| Not started yet | `trial` | `trialing` | `null`         | `null`             |
| Active          | `trial` | `trialing` | trial `endsAt` | `null`             |
| Expired         | `trial` | `lapsed`   | trial `endsAt` | `null`             |

**Override.** When 56c ships it will write a `subscription` record into the Clerk user's
`privateMetadata`, shaped `{ plan, status, renewsAt?, manageBillingUrl? }`. If a **valid** record is
present it is used verbatim (and wins over the trial derivation). Validation is strict: `plan` and
`status` must each match the enums above or the whole record is ignored (the trial fallback applies);
a malformed `renewsAt` or a non-`https` `manageBillingUrl` is dropped to `null` rather than poisoning
an otherwise-valid record.

### `DELETE /v1/me` (item 73)

Requires `Authorization: Bearer <clerk-session-token>`. **Deletes the account.** Returns **`204`** with
no body on success.

What is deleted:

1. The account's **usage Durable Object** first receives a deletion barrier (`AccountQuota`
   `/begin-delete`). This blocks later `/check`, `/reserve`, `/settle`, `/defer-settlement`,
   `/defer-release`, `/release`, and `/peek` calls so an in-flight authenticated request cannot
   recreate state during deletion.
2. The **Clerk user** is then deleted via Clerk's REST API, which removes `trialStartedAt` and any
   `subscription` / `quota` metadata.
3. After Clerk deletion succeeds (including idempotent 404), the Durable Object finalizes deletion
   (`/finish-delete`): all weekly counters, in-flight reservations, settlement markers, and the
   settlement alarm are removed, while a minimal deleted tombstone remains.

If Clerk returns a definitive non-404 failure response, the deletion barrier is cancelled and the
existing metering state is preserved; quota is not reset for an active account. That failure returns
**`502 account_deletion_failed`** with a user-safe message and no upstream detail.

If the Clerk delete times out or fails at the transport layer, the outcome is unknown because Clerk
may still have committed the deletion. In that case the Worker returns
**`503 account_deletion_status_unknown`** and deliberately leaves the Durable Object deletion barrier
active. The Durable Object alarm continues checking Clerk; it finalizes deletion if Clerk confirms
the user is gone, retries the idempotent Clerk delete when the user still exists, and leaves the
barrier active for another alarm pass if Clerk cannot be reached. A user with a still-valid session
can also retry `DELETE /v1/me`.

The call is **idempotent**: if the Clerk user is already gone it still returns `204`.

What is **not** deleted: the **Analytics Engine** usage metrics. They contain no content, email, or
raw userId, but they are pseudonymous per-account metric rows keyed by a deterministic SHA-256 hash
of the Clerk userId and retained for aggregate margin/usage reporting (see
[Privacy design](#privacy-design--content-stateless-by-construction)). Local Mac data (mail, voice
profile) never leaves the machine and is untouched by this call.

### `POST /v1/draft`

Requires `Authorization: Bearer <clerk-session-token>`. Body mirrors the app's `LLMRequest`:

```json
{
  "model": "claude-sonnet-4-6",
  "system": "…voice profile…",
  "messages": [{ "role": "user", "content": "…" }],
  "maxTokens": 4096,
  "temperature": 0.7
}
```

`model`, `maxTokens`, `temperature`, and `system` are optional (model defaults to
`claude-sonnet-4-6`). Returns the drafted text, token usage, and the account's current quota:

```json
{
  "text": "…",
  "usage": { "inputTokens": 1234, "outputTokens": 567 },
  "quota": {
    "unit": "drafts",
    "used": 13,
    "limit": 100,
    "remaining": 87,
    "resetsAt": "2026-09-07T00:00:00.000Z",
    "tokensUsed": 241801,
    "tokenLimit": 2000000,
    "enforcement": "soft",
    "extraPurchased": 0
  }
}
```

On an expired trial it returns **HTTP 402** with `{ "error": { "type": "trial_expired", … } }`. All
errors are structured JSON with a stable `error.type`; the Sentwise app maps these to plain messages.
See [Metering](#metering-56b) for the metering-specific error codes (`rate_limited`,
`request_too_large`, `quota_exceeded`).

## The 14-day trial

Full-featured, enforced server-side. On the first authenticated `/v1/draft` call, the Worker stamps
`trialStartedAt` into the user's Clerk `privateMetadata`. Fourteen days later, `/v1/draft` returns
`402 trial_expired`. Paid state arrives with checkout in **56c**.

## Metering (56b)

Per-account usage metering, weekly caps, and rate limiting. The model (owner decision 2026-08-29): a
**weekly allotment that resets weekly**, then pay-per-use overage (the purchase flow is 56c; 56b
meters, enforces, and surfaces the numbers).

**Window semantics.** The allotment window is one week starting **Monday 00:00 UTC**; it rolls on a
lazy reset (the next request at/after `resetsAt` starts a fresh, zeroed window). Counters live in the
`AccountQuota` Durable Object, one instance per Clerk userId. The `quota` object on `/v1/me` and
`/v1/draft` reports `used` / `limit` / `remaining` (drafts), `tokensUsed` / `tokenLimit`, the
`resetsAt` timestamp, the `enforcement` mode, and `extraPurchased` (overage credits added to the
limit for the current window).

**Per-request pipeline** (`POST /v1/draft`): authenticate → trial → parse → **rate-limit** →
**token safety cap** → **atomic weekly quota reservation** → forward to Anthropic → settle usage →
respond. If Anthropic fails after reservation, the reserved draft is released; if immediate settlement
fails after Anthropic succeeds, the completed draft is still returned and the settlement is queued in
the account Durable Object for alarm retry. Abandoned reservations expire after 15 minutes so leaked
capacity is reclaimed before the weekly reset.

**Enforcement modes** (`ENFORCEMENT_MODE`):

- `soft` (default): meter and report, but never block on the weekly quota — `remaining` clamps at 0
  and drafting continues past the cap. The rate limit and the per-request safety cap are always hard.
- `hard`: also block over-quota drafts with `429 quota_exceeded`; token capacity is reserved with a
  conservative `UTF-8 input bytes + per-message framing + max_tokens` bound before forwarding.

**Error codes:**

| HTTP | `error.type`        | When                                                                |
| ---- | ------------------- | ------------------------------------------------------------------- |
| 429  | `rate_limited`      | Over `RATE_LIMIT_PER_MIN` (sliding 60s). Includes `Retry-After`.    |
| 413  | `request_too_large` | Estimated request tokens exceed `MAX_TOKENS_PER_REQUEST`.           |
| 429  | `quota_exceeded`    | Weekly cap reached **and** `ENFORCEMENT_MODE=hard`. Has `resetsAt`. |

**Config vars** (in `wrangler.jsonc` `vars`; placeholder defaults, final numbers land with 56c):

| Var                      | Default   | Meaning                                                                |
| ------------------------ | --------- | ---------------------------------------------------------------------- |
| `WEEKLY_DRAFT_LIMIT`     | `100`     | Drafts per account per week.                                           |
| `WEEKLY_TOKEN_LIMIT`     | `2000000` | Input+output tokens per account per week.                              |
| `RATE_LIMIT_PER_MIN`     | `10`      | Requests per 60s per account (abuse guard).                            |
| `MAX_TOKENS_PER_REQUEST` | `55000`   | Per-request safety cap; bound as `UTF-8 bytes + framing + max_tokens`. |
| `ENFORCEMENT_MODE`       | `soft`    | `soft` (meter only) or `hard` (block over-quota).                      |

**Per-account overrides.** `privateMetadata.quota` on the Clerk user —
`{ weeklyDraftLimit?, weeklyTokenLimit?, extraDrafts?, extraDraftsWindowStart? }` — overrides the
vars for that account. `extraDrafts` is added only when `extraDraftsWindowStart` equals the current
weekly window's Monday 00:00 UTC epoch-ms `windowStart`; stale or unscoped credits are ignored. These
are read on the same `getUser` as the trial, so metering adds no extra Clerk round-trip.

**Privacy.** The Durable Object stores only integers and timestamps; it never sees prompt or draft
content. See the [Privacy design](#privacy-design--content-stateless-by-construction) section.

### `POST /v1/interest` (item 75 — demand capture)

Requires `Authorization: Bearer <clerk-session-token>`. Records that the signed-in user asked to be
notified when a **parked capability** ships — today only sign-in-with-Google (the OAuth path the app
offers when Workspace IMAP fails). This turns demand for the parked path into a measured signal
instead of a guess.

Request body:

```json
{ "topic": "google-oauth" }
```

`topic` must be one of a small server-side allowlist (currently just `google-oauth`; extend
`INTEREST_TOPICS` in `src/interest.ts`). On success the Worker sets
`privateMetadata.interest[topic]` on the user's own Clerk account to the ISO timestamp of the
**first** click and returns **`204`** with no body. **First click wins:** a repeat call never
overwrites the original timestamp and still returns `204` (idempotent). The write merges into
`privateMetadata` exactly like `trialStartedAt`, leaving trial/quota/subscription keys untouched.

- Unknown/missing `topic` or malformed JSON → **`400 invalid_request`**.
- Missing/invalid session → **`401`**; wrong method (e.g. `GET`) → **`405`**.
- A Clerk read/write failure → **`502 interest_failed`** (user-safe message, nothing logged).

**Privacy.** The only thing stored is a topic name + timestamp on the user's own account — no mail,
prompt, or draft content ever touches this path. There is no new dashboard: the maintainer reads
demand by filtering Clerk users on `privateMetadata.interest`.

### `GET /admin/margin` (maintainer only)

A margin dashboard for the maintainer. Guarded by the `ADMIN_TOKEN` secret (constant-time compare);
when `ADMIN_TOKEN` is unset the endpoint returns **404** (invisible). It queries Workers Analytics
Engine's SQL API for the last 7 and 30 days — drafts, tokens, estimated cost, cost-per-draft p50/p95,
top-10 accounts by cost (hashed ids), active accounts, and projected monthly cost vs. the assumed
\$19/mo revenue per active account. If `CF_ANALYTICS_API_TOKEN` is unset (or a query fails) it
degrades to **503 `analytics_unavailable`**. Reads aggregate hashed metrics only — no content.

The per-model cost table lives in `src/config.ts` (`MODEL_COSTS`, Sonnet 4.6 as the default row);
edit it there when pricing changes or a new model is added.

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
- `ADMIN_TOKEN` — **56b, optional.** Bearer token that guards `GET /admin/margin`; when unset the
  endpoint 404s.
- `CF_ANALYTICS_API_TOKEN` — **56b, optional.** A Cloudflare API token with **Account Analytics
  read** permission, used by `/admin/margin` to query the Analytics Engine SQL API. When unset,
  `/admin/margin` returns `503 analytics_unavailable`.

Push them to the Worker with (values are read from the file, never printed):

```bash
grep '^ANTHROPIC_API_KEY=' ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put ANTHROPIC_API_KEY
grep '^CLERK_SECRET_KEY='  ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put CLERK_SECRET_KEY
# 56b margin dashboard (optional):
grep '^ADMIN_TOKEN='            ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put ADMIN_TOKEN
grep '^CF_ANALYTICS_API_TOKEN=' ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put CF_ANALYTICS_API_TOKEN
```

### Metering storage (56b)

Metering adds two Cloudflare bindings, already declared in `wrangler.jsonc`:

- a **Durable Object** namespace `ACCOUNT_QUOTA` (class `AccountQuota`, SQLite-backed via the `v1`
  migration) for per-account usage counters, and
- a **Workers Analytics Engine** dataset `USAGE_ANALYTICS` (`sentwise_usage`) for the margin metrics.

No manual provisioning is needed — `wrangler deploy` creates them from the config. The DO and dataset
store counters and hashed ids only; see [Metering](#metering-56b).

### Deploy

```bash
npm run deploy     # runs typecheck + tests first (predeploy), then wrangler deploy
```

## License

MIT — see [LICENSE](./LICENSE).
