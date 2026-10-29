# Backlog

Prioritized list of planned features, fixes, and technical debt for **sentwise-service**, the Cloudflare Worker behind Sentwise (managed inference, accounts, metering, and Paddle checkout/licensing).

> **Item format:** every item has a stable numeric ID, a bold title, a one-line summary, and acceptance criteria. Item numbers are stable IDs: they are never reused or renumbered when items are completed. New items go at the bottom of their priority tier. Items that touch the app and the service together are tracked in `michaeltookes/sentwise` and referenced here by that number. Completed items stay in place marked **Done** with the branch or PR that closed them.

---

## High Priority

_None open._

## Medium Priority

1. **manage-billing reads Clerk metadata uncached** — **Done** (branch `manage-billing-uncached-clerk`)
   `GET /v1/paddle/manage-billing` read the Clerk user through the 30-second S-M1 display cache, so right after a webhook created or replaced a subscription it could return 404 or mint a portal URL for the old subscription. Found by Codex review on PR #37 (P2).
   - ✅ The manage-billing handler reads the Clerk user fresh (`useCache: false`).
   - ✅ `GET /v1/me` still uses the cache.
   - ✅ Test: with a cached record holding the old subscription, manage-billing returns the portal URL for the new one, and a following `/v1/me` makes no extra Clerk lookup.
   - ✅ Because every request now costs a Clerk Backend API call (the no-subscription 404 path never reaches Paddle), the route is rate-limited per account **before** the Clerk lookup, on the same Durable Object sliding-60s limiter as `POST /v1/draft` but in its own bucket (`rate:manage_billing`) so drafting and billing never block each other. Limit: `MANAGE_BILLING_RATE_LIMIT_PER_MIN = 10` — a person opening the billing portal makes one or two requests, so a real user cannot hit it, while one session can no longer drain Clerk's shared limit. Over-limit requests get the existing `429 rate_limited` with `Retry-After`. Found by Codex headless review (P1).
   - ✅ Tests: over-limit requests return 429 with no Clerk call and no Paddle call; under-limit requests each read Clerk fresh; filling the draft bucket does not block billing.

2. **Learning allowance: durable settlement and deletion recheck** — open (leftovers from the Codex review of branch `139-learning-purpose`, 2026-10-28; all bounded to the 10-per-month voice-learning allowance, no effect on draft quota)
   Voice learning (`POST /v1/draft` with `purpose: voice_learning`, sentwise item 139) reserves one learning unit with a 15-minute expiry and settles it with the idempotent `/learn-finish`. Three edge cases let a successful learning call go uncounted or touch deleted state:
   - If Anthropic succeeds but both `/learn-finish` attempts fail, the handler returns the profile without scheduling settlement recovery; after 15 minutes the reservation expires and the successful call is refunded (more than ten successful learning calls become possible in a month). Give successful learning calls the durable settlement retry the draft path has.
   - `/learn-finish` passes the deletion preflight but never rechecks the deletion marker inside its transaction, so an in-flight finish can recreate the `learning` key after account cleanup wiped storage. Add the transactional check the other quota mutations use.
   - A provider request longer than the 15-minute TTL finds its reservation already expired (`held` false) and the successful completion is silently ignored. Keep reservation and deduplication metadata long enough to count late successes, as draft settlement does, or put a timeout on the upstream fetch.
   - Also: the fallback quota snapshot returned after a transient post-inference read failure shows `used: 0` instead of the real count; and the app maps `learning_limit_exceeded` (429) to a generic error (sentwise app follow-up, file there when picked up).
   - Tests for each case; CI is the gate.

## Low Priority

2. **Move tests to `@cloudflare/vitest-plugin`, vitest 5 and the newest TypeScript** — **Done** (branch `vitest-plugin-migration`)
   `@cloudflare/vitest-pool-workers` is deprecated (renamed to `@cloudflare/vitest-plugin`) and its 0.23 peer range pins vitest ^4.1, so dependabot could not move vitest or TypeScript past their majors (genkei-ops 6g, second half; the dependabot ignore rules came in PR #42).
   - ✅ `vitest.config.ts`, `tsconfig.json` and `test/env.d.ts` use `@cloudflare/vitest-plugin`; `@cloudflare/vitest-pool-workers` is removed.
   - ✅ vitest 5. Its default `fsModuleCache` is turned off because the workerd runner cannot read the host-side `node_modules/.vitest-cache`.
   - ✅ TypeScript 6.0.3 (`~6.0.3`). TypeScript 7 typechecks the repo cleanly but typescript-eslint 8.71 supports `typescript <6.1.0`, so 7 waits for typescript-eslint.
   - ✅ All 505 tests pass; lint, typecheck and `check-no-body-logging` are clean.
   - ✅ dependabot's vitest major-ignore rule is lifted; the TypeScript one stays until typescript-eslint supports 7.

3. **Sandbox deploy smoke check retries during workers.dev propagation** — **Done** (branch `sandbox-smoke-retry`)
   The `Smoke check` step in `.github/workflows/deploy-sandbox.yml` runs `curl -fsS .../healthz` once, one second after `wrangler deploy`. On the first deploy of the sandbox Worker (run 38646948889, 2026-10-18) the new `workers.dev` hostname returned 404 before it was live, the step failed, and the run was red although the Worker was healthy seconds later. Item 123 (sentwise) found it.
   - [x] The smoke check retries `GET /healthz` under one overall deadline of about two minutes (polling every 8 s, each transfer time-capped) and fails only when the deadline passes; the body of the final failed response is printed.
   - [x] A 200 ends the loop at once, so the common case stays as fast as today.
   - [x] `docs/sandbox-deployment.md` names the retry window in the smoke-check sentence.
   - [x] No change to the deploy command, the secrets file handling, or the production workflow.
