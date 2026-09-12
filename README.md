# sentwise-service

The managed-inference service for **[Sentwise](https://github.com/michaeltookes/sentwise)** — a
stateless [Cloudflare Worker](https://workers.cloudflare.com/) that lets a signed-in Sentwise user
draft email through the model provider **without ever holding an API key**. It is the server half of
backlog items **56a** (account + proxy), **56b** (metering + limits), **56c** (checkout + licensing —
the Paddle webhook + entitlement writes), and the account-management half of **73** (subscription
display + account deletion).

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
Checkout / licensing (**56c**) is handled by the Paddle webhook that writes the account's entitlement
(see [Checkout & licensing](#checkout--licensing-56c)); an active paid subscription grants drafting
access past the 14-day trial.

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
  1. `trialStartedAt` and `subscription` in the user's Clerk `privateMetadata` (trial enforcement,
     56a; subscription/licensing written by the Paddle webhook, 56c; subscription display, 73).
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
src/index.ts      router: /healthz, GET+DELETE /v1/me, /v1/draft, POST /v1/interest, POST /v1/paddle/checkout, POST /v1/paddle/change-plan, GET /v1/paddle/manage-billing, POST /v1/paddle/webhook, /admin/margin
  -> src/auth.ts            verify Clerk JWT, check/init the trial + read quota/subscription; delete user
  -> src/subscription.ts    derive the account's subscription (trial fallback + 56c override) — pure
  -> src/anthropic.ts       forward to Anthropic, map the response — no logging, no storage
  -> src/quota-do.ts        per-account usage counters + serialized metadata writes (Durable Object)
  -> src/analytics.ts       one aggregate hashed metric per draft — no content
  -> src/interest.ts        record demand for a parked capability — a topic key + timestamp, no content
  -> src/paddle.ts          verify Paddle signature + map billing event -> entitlement (56c) — pure
  -> src/paddle-management.ts  fresh Paddle billing-management redirects — no URL persistence
  -> src/paddle-plan.ts     in-app plan change: PATCH the Paddle subscription + write the new tier limit (90)
  -> src/paddle-webhook.ts  dispatch signed events to serialized entitlement writes (56c) — no body logging
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

- `plan`: `"trial" | "starter" | "pro" | "unlimited" | "team" | "none"`
- `status`: `"trialing" | "active" | "past_due" | "canceled" | "lapsed"`
- `renewsAt`: ISO 8601 timestamp, or `null`
- `manageBillingUrl`: compatibility field; always `null` because Paddle billing portal URLs are
  temporary and fetched on demand

**Trial fallback.** Before checkout, the field is **derived from the trial** on the same Clerk
`getUser` as `trial`/`quota` (no extra round-trip):

| Trial state     | `plan`  | `status`   | `renewsAt`     | `manageBillingUrl` |
| --------------- | ------- | ---------- | -------------- | ------------------ |
| Not started yet | `trial` | `trialing` | `null`         | `null`             |
| Active          | `trial` | `trialing` | trial `endsAt` | `null`             |
| Expired         | `trial` | `lapsed`   | trial `endsAt` | `null`             |

**Override (written by 56c).** After checkout, the Paddle webhook (see
[Checkout & licensing](#checkout--licensing-56c)) writes a `subscription` record into the Clerk
user's `privateMetadata`. When a **valid** record is present it wins over the trial derivation.
Validation is strict: `plan` and `status` must each match the enums above or the whole record is
ignored (the trial fallback applies); a malformed `renewsAt` is dropped to `null` rather than
poisoning an otherwise-valid record. Any legacy stored `manageBillingUrl` is ignored. The stored
record carries extra reconciliation/idempotency fields (`paddleSubscriptionId`, `paddleCustomerId`,
`priceId`, `updatedAt`, `lastEventId`) that this endpoint reads past — only the public wire fields
above are returned.

### `GET /v1/paddle/manage-billing`

Requires `Authorization: Bearer <clerk-session-token>`. Reads the account's stored
`paddleSubscriptionId`, mints a **fresh** authenticated link **on demand**, and returns
**`200`** with `{ "managementUrl": "<fresh Paddle URL>" }` and `Cache-Control: no-store`. The app
should navigate the browser to the returned URL.

The optional **`?action=`** query param selects which management link to return:

- `action=update_payment_method` (the default when omitted) → the payment-method / billing portal link.
- `action=cancel` → the cancellation link.

Any other `action` value returns **`400 invalid_request`**.

**Customer portal sessions first (item 91).** The endpoint prefers an **authenticated
customer-portal-session** deep link — `POST /customers/{customer_id}/portal-sessions` — because those
links log the customer straight into the portal, skipping the email sign-in step that the pre-generated
`management_urls` links land on. The requested `action` maps to the matching per-subscription deep link
in the session response's `urls.subscriptions[]` entry (matched by the stored subscription id):
`cancel` → `cancel_subscription`, `update_payment_method` → `update_subscription_payment_method`. If no
per-subscription entry matches, it uses `urls.general.overview`. The customer id comes from the
webhook-stored `subscription.paddleCustomerId`; when absent it is recovered from the live
`GET /subscriptions/{id}` payload (`data.customer_id`).

**Fallback.** If the portal-session create fails for any reason (no API key, non-2xx, network error,
missing customer id, or no valid https link), the endpoint falls back to the legacy
`management_urls` path — `GET /subscriptions/{id}` → `data.management_urls[action]` — so billing
management never regresses to a dead button.

Session and `management_urls` links are both temporary, so this endpoint is the **reliable** on-demand
source and its output is never cached. The stored `subscription.manageBillingUrl` is intentionally
always `null` (the webhook never persists these temporary links and `/v1/me` never returns one), so
clients must call this endpoint each time they need a portal link.

Returns **`404 billing_subscription_not_found`** when the account has no Paddle subscription id, and
**`502 billing_portal_unavailable`** when neither a portal session nor a `management_urls` link yields a
valid URL.

### `DELETE /v1/me` (item 73)

Requires `Authorization: Bearer <clerk-session-token>`. **Deletes the account.** Returns **`204`** with
no body on success. Accounts with an active, trialing, or past-due paid Paddle subscription must cancel
the subscription first; deletion returns **`409 billing_subscription_active`** until then.

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
`402 trial_expired`. Paid state arrives via checkout (see [Checkout & licensing](#checkout--licensing-56c)).

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
`{ weeklyDraftLimit?, weeklyTokenLimit?, extraDrafts?, extraDraftsWindowStart?, processedOverageEventIds? }`
— overrides the vars for that account. `extraDrafts` is added only when `extraDraftsWindowStart`
equals the current weekly window's Monday 00:00 UTC epoch-ms `windowStart`; stale or unscoped credits
are ignored. `weeklyDraftLimit: null` is treated as absent and is used by the Paddle webhook to clear
Clerk's deep-merged paid override. These are read on the same `getUser` as the trial, so metering
adds no extra Clerk round-trip.

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

## Checkout & licensing (56c)

Checkout and licensing run on **Paddle**. The app asks this Worker to create a Paddle transaction for
the authenticated account, then opens that transaction in Paddle.js; Paddle then calls this Worker's
webhook, which turns billing events into the account's entitlement — the `subscription` record read by
[`GET /v1/me`](#subscription-item-73) and the per-tier weekly draft limit enforced by
[Metering](#metering-56b). The app never mints a license itself; **Paddle → this webhook → Clerk
`privateMetadata`** is the only source of truth.

### `POST /v1/paddle/checkout`

**Clerk bearer required.** The request body is `{ "priceId": "pri_...", "quantity": 1 }`.
`priceId` must be one of the configured subscription tier prices or `EXTRA_DRAFTS_PRICE_ID`.
Subscription quantities must be `1`; omitted quantities default to `1`, explicitly supplied
quantities must be positive integers, and overage quantities are capped. Subscription checkout is
rejected while the account already has an active/trialing/past-due Paddle subscription, so tier
changes must go through [`POST /v1/paddle/change-plan`](#post-v1paddlechange-plan) (an in-place
Paddle subscription update) instead of creating a second recurring subscription. Subscription
checkout creation is also serialized per account with a short-lived
Durable Object reservation id included in Paddle `custom_data`; a second request is rejected while a
checkout transaction is pending, a retry resumes only a matching requested price/quantity, and only
the matching applied subscription webhook clears the lock.
Overage checkout requires an active Paddle subscription with a stored
`paddleCustomerId`; the Worker passes that `customer_id` to Paddle so the later webhook credits the
same bound customer.

The Worker creates `POST /transactions` in Paddle with server-minted `custom_data` and returns:

```json
{ "transactionId": "txn_...", "checkoutUrl": "https://..." }
```

The app should open the returned `transactionId` with Paddle.js. `checkoutUrl` is present when Paddle
returns its hosted payment link.

### `POST /v1/paddle/change-plan`

**Clerk bearer required.** In-app upgrade/downgrade of the account's existing paid subscription to a
different tier (item 90). The request body is `{ "priceId": "pri_..." }`, where `priceId` is the
**target tier's** subscription price (one of the configured `PRICE_TO_PLAN` prices). Unlike
`POST /v1/paddle/checkout`, this changes the current subscription in place rather than starting a new
one.

Behavior:

- Resolves the target tier from `PRICE_TO_PLAN` (an unknown price is rejected).
- Loads the account's stored `paddleSubscriptionId`; a `404` is returned if the account has no Paddle
  subscription to change.
- Rejects a no-op change to the price the account is already on.
- `PATCH`es Paddle `/subscriptions/{id}`, replacing the recurring item with the target price at
  quantity `1`. **Proration:** both upgrades and downgrades use
  `proration_billing_mode: "prorated_immediately"` — the new tier applies immediately (the higher
  tier is charged pro rata on an upgrade; the lower tier is credited pro rata on a downgrade). A
  single immediate mode keeps this endpoint's optimistic entitlement write and the
  `subscription.updated` webhook's reconciliation in agreement, avoiding a "takes effect next period"
  state where the stored weekly limit would disagree with the tier actually being paid for.
- Confirms Paddle's successful response reports the requested recurring price before granting the
  optimistic entitlement; missing or mismatched returned items fail as `502 subscription_change_failed`.
- Queues the optimistic entitlement write through the account Durable Object, re-reading the latest
  Clerk metadata there before bumping the stored `subscription` record's `plan`/`priceId` and the
  active paid tier's `privateMetadata.quota.weeklyDraftLimit`. The queued write is skipped if the
  latest Clerk subscription no longer has the initially observed price and ordering timestamp,
  unless it already has the requested target price. Every reconciliation/idempotency field
  (`updatedAt`, `lastEventId`, `paddleOccurredAt`, `paddleSubscriptionId`, `paddleCustomerId`,
  superseded ids) is preserved; the `subscription.updated` webhook Paddle fires for this change
  carries a newer `occurredAt` and reconciles authoritatively. The two paths are serialized,
  consistent, and idempotent.

Returns **`200`** with `Cache-Control: no-store` and:

```json
{ "ok": true, "plan": "pro", "status": "active" }
```

Errors: **`400 invalid_request`** (missing/unknown/same-tier price), **`404
billing_subscription_not_found`** (no Paddle subscription id on the account), **`502
subscription_change_failed`** (Paddle API failure), and **`503 checkout_unavailable`** when
`PADDLE_API_KEY` is not configured. Raw Paddle/Clerk detail is never leaked.

### `POST /v1/paddle/webhook`

**No Clerk bearer.** This endpoint is authenticated by the **Paddle signature**, not a session token,
so it runs before the normal auth. Verification (per Paddle's "Verify webhook signatures"):

- The `Paddle-Signature` header is `ts=<unix-seconds>;h1=<hex>`. The signed payload is
  `"<ts>:<rawBody>"` using the **exact raw request body** (no re-serialization).
- `h1` is an **HMAC-SHA256** hex digest under `PADDLE_WEBHOOK_SECRET`, compared **constant-time**.
  Multiple `h1` values are accepted when any one matches, so Paddle signing-secret rotation does not
  reject legitimate webhooks.
- The `ts` must be within `PADDLE_WEBHOOK_TOLERANCE_SEC` of now (default **300 s**; Paddle's own SDK
  default is a very tight 5 s — idempotency, not the clock, is our real replay defense).
- Any failure → **`401 invalid_signature`**, and the event is **never processed**.

**Events handled** (others are acknowledged `200` and ignored):

| Event                                                                                                   | Write                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription.activated` / `.created` / `.updated` / `.canceled` / `.past_due` / `.paused` / `.resumed` | `privateMetadata.subscription` (plan/status/renewsAt + reconciliation ids). Active/trialing/past-due statuses set `privateMetadata.quota.weeklyDraftLimit`; canceled/paused statuses write `weeklyDraftLimit: null` to clear Clerk's deep-merged paid override |
| `transaction.completed` (overage / "buy more drafts")                                                   | `privateMetadata.quota.extraDrafts` (+`extraDraftsWindowStart`), stamped to the **current Monday window** so 56b counts it; requires `EXTRA_DRAFTS_PRICE_ID`                                                                                                   |
| `adjustment.created` / `.updated` (approved refund/chargeback/credit/reversal)                          | Marks matching overage credits reversed/restored, including partial transaction-item adjustments; pre-purchase reversals are retained until completion                                                                                                         |

**Account mapping.** `data.custom_data.clerkUserId` identifies the candidate Clerk user only when it
is accompanied by this Worker's signed `sentwiseCheckoutBinding` from `POST /v1/paddle/checkout`, or
when the Paddle `customer_id` already matches the account's stored `paddleCustomerId`. Events without
custom data first load the original transaction (`GET /transactions/{id}`) and validate its signed
checkout binding when Paddle provides a `transaction_id`; otherwise, they may use Paddle
customer-email lookup (`GET /customers/{id}` → `getUserList`) only to locate a previously-bound
account. Email equality alone never creates a first-time binding. If no account matches, or if the
candidate user does not match the Paddle customer, the event is
acknowledged `200` (`{ mapped: false }`) — retrying wouldn't help. Transient Paddle/Clerk lookup
failures and missing Paddle API credentials return `502` so Paddle retries.

**Price → tier.** `data.items[].price.id` maps to a tier via `PRICE_TO_PLAN` in `src/config.ts`
(SANDBOX ids today):

| Price id                         | Tier        | Weekly draft limit (var)      |
| -------------------------------- | ----------- | ----------------------------- |
| `pri_01m1syd7nfarp8pggpcnvjbgyy` | `starter`   | `STARTER_DRAFT_LIMIT` (30)    |
| `pri_01m1symsxarc4c3jdea0ntb09w` | `pro`       | `PRO_DRAFT_LIMIT` (120)       |
| `pri_01m1syrdg05f49kz705gbzn6tz` | `unlimited` | `UNLIMITED_DRAFT_LIMIT` (1e5) |

The Durable Object also stores the selected paid plan on the pending subscription checkout
reservation, so a matching signed subscription webhook can still apply the purchased tier if a
catalog migration removes or replaces the old price id before Paddle delivers the event.

The limits are **placeholders**, tunable per-deploy without a release. ⚠️ **Open owner decision:** the
landing page says "per **month**", but 56b enforces a **weekly** window — the window unit and the real
per-tier numbers are unresolved. The plumbing is deliberately window-agnostic (it writes whatever the
var holds and stamps overage to the 56b Monday window); it does not encode a final answer.

**Billing management.** Paddle portal URLs are temporary authenticated links, so the webhook never
persists them. The app should open `GET /v1/paddle/manage-billing` for payment-method changes or
`GET /v1/paddle/manage-billing?action=cancel` for cancellation, which mints a fresh authenticated
customer-portal-session deep link on demand (falling back to `GET /subscriptions/{id}` →
`data.management_urls` if the session create fails) and returns the requested URL in JSON for the app
to navigate to. See [`GET /v1/paddle/manage-billing`](#get-v1paddlemanage-billing) for the
portal-session details.

**Overage credit.** Extra drafts are derived from matching Paddle line-item quantity times
`EXTRA_DRAFTS_PER_UNIT`. Buyer-controlled `custom_data.extraDrafts` is ignored. Each credit stores
the Paddle transaction id and, when Paddle provides it, the transaction item id and item total.
Approved Paddle refund/chargeback/credit adjustments mark matching credits as reversed and subtract
any still-current weekly extras; partial adjustments are prorated from the cumulative adjusted amount
before calculating each incremental draft change. Approved
chargeback/credit reversals restore only drafts revoked by the corresponding chargeback/credit
action. Tax/proration-only adjustment items are ignored rather than treated as whole-overage
reversals. If an approved reversal or restore arrives before the matching prerequisite event, it is
retained in `pendingOverageReversals` and applied when the prerequisite is later delivered. The
authoritative refundable-credit ledger is stored in the account Durable Object, not Clerk metadata,
so later Paddle adjustments can still find older overage transactions without growing
`privateMetadata.quota` indefinitely. Per-credit reversal/restore adjustment IDs remain in that
ledger for the refundable lifetime of the credit, so an old adjustment replay is still idempotent
after the small processed-id ring buffer has rotated.

**Idempotency & ordering.** Subscription, in-app plan-change, and overage entitlement writes run
through the per-user Durable Object so overlapping updates for one account are serialized before
Clerk metadata is read and updated. Subscription writes are skipped when the incoming `event_id`
equals the stored `lastEventId`,
when a strictly older `occurred_at` would clobber a newer stored record, or when a different
subscription id is already known as superseded. A different subscription may replace the stored one
only with a signed checkout binding and a live Paddle subscription lookup confirming the event's
current Paddle status for the same customer. Overage writes are skipped when the `event_id` is in the
bounded `processedOverageEventIds` list (the legacy
`lastOverageEventId` is still honored). Approved adjustment reversals/restores are skipped when the
`adjustment_id` is in the bounded `processedOverageAdjustmentIds` list; unmatched approved
reversals/restores are retained in a bounded `pendingOverageReversals` list by transaction id. A
transient Clerk failure returns **`502`** so Paddle retries.

**Privacy.** This endpoint handles only plan/status/timestamps and price/subscription/customer ids
(plus a customer email used solely to locate a previously-bound account). It never sees prompt or
draft content and **never logs the raw webhook body** (enforced by
`scripts/check-no-body-logging.sh`).

**Going live (owner, after the app half lands).** Nothing is live until the owner: (1) sets the two
Paddle secrets (below); (2) in the Paddle dashboard creates a **notification destination** pointing at
`https://sentwise-inference.sentwise-service.workers.dev/v1/paddle/webhook`, subscribed to
`subscription.activated`, `subscription.created`, `subscription.updated`, `subscription.canceled`,
`subscription.past_due`, `subscription.paused`, `subscription.resumed`, `transaction.completed`,
`adjustment.created`, and `adjustment.updated`, and copies its signing secret into
`PADDLE_WEBHOOK_SECRET`; (3) when moving off sandbox, flips `PADDLE_API_BASE` to
`https://api.paddle.com` and swaps the sandbox price ids in `PRICE_TO_PLAN` for live ids. End-to-end
verification (a real Paddle test event → a real entitlement write) happens then.

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
- `PADDLE_WEBHOOK_SECRET` — **56c.** The Paddle notification-destination signing secret
  (`pdl_ntfset_…`) that verifies `POST /v1/paddle/webhook`. It also signs the checkout account
  binding unless `PADDLE_CHECKOUT_BINDING_SECRET` is set. When unset, every webhook is rejected
  `401` and `POST /v1/paddle/checkout` is unavailable.
- `PADDLE_CHECKOUT_BINDING_SECRET` / `PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET` — **56c, optional.**
  Stable HMAC secrets for server-minted checkout bindings; the previous secret is accepted during
  rotations so in-flight Paddle transactions can still map their first webhook.
- `PADDLE_WEBHOOK_MAX_BODY_BYTES` — **56c, optional.** Max Paddle webhook payload size before
  signature verification; defaults to 128 KiB.
- `PADDLE_API_KEY` — **56c.** A Paddle API key (`transaction.write`, `transaction.read`,
  `subscription.read`, and `customer.read`) used by `POST /v1/paddle/checkout`,
  `GET /v1/paddle/manage-billing`, cross-subscription replacement checks, and webhook fallback
  mapping. Missing credentials make those operations fail closed with `5xx` instead of acknowledging
  paid events.

Push them to the Worker with (values are read from the file, never printed):

```bash
grep '^ANTHROPIC_API_KEY=' ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put ANTHROPIC_API_KEY
grep '^CLERK_SECRET_KEY='  ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put CLERK_SECRET_KEY
# 56b margin dashboard (optional):
grep '^ADMIN_TOKEN='            ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put ADMIN_TOKEN
grep '^CF_ANALYTICS_API_TOKEN=' ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put CF_ANALYTICS_API_TOKEN
# 56c checkout + licensing:
grep '^PADDLE_WEBHOOK_SECRET=' ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put PADDLE_WEBHOOK_SECRET
grep '^PADDLE_API_KEY='        ~/.config/sentwise-service/.env | cut -d= -f2- | npx wrangler secret put PADDLE_API_KEY
```

> ⚠️ **Empty-secret gotcha.** `wrangler secret put` reads the value from stdin. The piped form above
> works, **but** if the `grep` matches nothing (the key is missing from `.env`) it pipes an empty
> string and uploads an **empty secret silently** — which then fails webhook verification with `401`.
> Confirm each `.env` line exists first, or run `npx wrangler secret put <NAME>` interactively in a
> real terminal and paste the value. Never run it under a non-interactive/piped shell with no data.

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
