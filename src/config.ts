// Central constants and the Worker environment binding shape.
//
// PRIVACY NOTE (backlog 56a/56b): this Worker is a *content-stateless* drafting
// proxy. It never logs the contents of `system`/`messages` (the user's mail) or
// the model's reply, and it never stores them anywhere. The only state it keeps
// is counters, timestamps, and random reservation IDs, never content:
//   1. `trialStartedAt` in the user's Clerk `privateMetadata` (56a).
//   2. Per-account usage counters + timestamps in a Durable Object (`AccountQuota`,
//      56b) — weekly drafts/tokens used, in-flight token reservations, a sliding
//      rate-limit window, and random reservation IDs keyed by Clerk userId. No
//      prompts, no drafts, no emails.
//   3. Aggregate, hashed usage metrics in Workers Analytics Engine (56b) — a SHA-256
//      hash of the userId (never the raw id), model, token counts, estimated cost,
//      latency, and outcome. No content.
// If you are auditing this claim, the request path is:
//   src/index.ts -> src/auth.ts -> src/anthropic.ts (draft forward)
//                -> src/quota-do.ts / src/quota-client.ts (counters)
//                -> src/analytics.ts (aggregate metrics)
// Grep the repo for `console.` — there is none; the only telemetry is error *types*
// and aggregate metrics, never bodies. Enforced in CI by scripts/check-no-body-logging.sh.

export interface Env {
  // Secrets — provided via `wrangler secret put` (prod) or .dev.vars (local).
  CLERK_SECRET_KEY: string;
  ANTHROPIC_API_KEY: string;
  // Public — safe to commit / expose. Present for parity / future use.
  CLERK_PUBLISHABLE_KEY: string;

  // 56b — metering. Durable Object namespace holding per-account usage counters.
  ACCOUNT_QUOTA: DurableObjectNamespace;
  // 56b — margin dashboard. Aggregate, hashed usage metrics. Optional so the
  // Worker still runs (and tests pass) if the binding is absent.
  USAGE_ANALYTICS?: AnalyticsEngineDataset;

  // 56b — tunable limits (wrangler `vars`; strings or numbers, coerced in metering.ts).
  WEEKLY_DRAFT_LIMIT?: string | number;
  WEEKLY_TOKEN_LIMIT?: string | number;
  RATE_LIMIT_PER_MIN?: string | number;
  MAX_TOKENS_PER_REQUEST?: string | number;
  ENFORCEMENT_MODE?: string; // "soft" (default) | "hard"

  // 56b — margin dashboard config. CF_ACCOUNT_ID is a public var; the two tokens
  // are secrets set via `wrangler secret put` and are optional (endpoint degrades).
  CF_ACCOUNT_ID?: string;
  ADMIN_TOKEN?: string; // guards GET /admin/margin; endpoint 404s when unset
  CF_ANALYTICS_API_TOKEN?: string; // Cloudflare API token for the Analytics Engine SQL API

  // 56c — checkout + licensing (Paddle). The two Paddle credentials are SECRETS
  // (set via `wrangler secret put`, never committed); the rest are public vars.
  PADDLE_WEBHOOK_SECRET?: string; // Paddle notification-destination secret (pdl_ntfset_…); verifies POST /v1/paddle/webhook
  PADDLE_API_KEY?: string; // Paddle API key (pdl_…); reads customer email + on-demand management URLs
  PADDLE_API_BASE?: string; // Paddle REST base; defaults to the SANDBOX base (PADDLE_SANDBOX_API_BASE)
  PADDLE_WEBHOOK_TOLERANCE_SEC?: string | number; // signature freshness window (seconds); default DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC

  // 56c — per-tier weekly draft limits. Server-side placeholders (measure-first,
  // like the 56b limits): tunable per-deploy without shipping a new binary, and
  // written per-account into Clerk `privateMetadata.quota.weeklyDraftLimit` by the
  // webhook so 56b enforcement uses them.
  STARTER_DRAFT_LIMIT?: string | number;
  PRO_DRAFT_LIMIT?: string | number;
  UNLIMITED_DRAFT_LIMIT?: string | number;

  // 56c — overage ("buy more drafts"). The one-time price id that credits extra
  // drafts, and how many drafts one unit buys. When unset, overage purchases are
  // ignored; buyer-supplied custom_data is never trusted for the credit amount.
  EXTRA_DRAFTS_PRICE_ID?: string;
  EXTRA_DRAFTS_PER_UNIT?: string | number;
}

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

// Default drafting model. Mirrors the Sentwise app's current default.
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 4096;

// Bound the pre-Clerk deletion barrier. The Worker gives the Clerk delete call a
// shorter timeout; the Durable Object alarm uses the longer barrier timeout to
// re-check the Clerk outcome, retrying deletion for still-present users and
// finalizing only after Clerk confirms the user is gone.
export const CLERK_DELETE_TIMEOUT_MS = 10_000;
export const ACCOUNT_DELETION_BARRIER_TIMEOUT_MS = 60_000;

// Full-featured trial length. Enforced server-side (56a decision).
export const TRIAL_DAYS = 14;
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

// Coarse per-request input cap (bytes of prompt content). This is a cheap
// pre-flight guard; 56b adds a token-estimate safety cap on top (see below).
export const MAX_TOTAL_CONTENT_CHARS = 200_000;

// ---------------------------------------------------------------------------
// 56b — metering + limits.
// ---------------------------------------------------------------------------

// Weekly allotment (owner decision 2026-08-29: weekly reset + pay-per-use
// overage). These are PLACEHOLDER defaults — final numbers land with 56c
// pricing. Overridable per-deploy via wrangler `vars`, and per-account via
// Clerk `privateMetadata.quota` (56c writes purchased extras there).
export const DEFAULT_WEEKLY_DRAFT_LIMIT = 100;
export const DEFAULT_WEEKLY_TOKEN_LIMIT = 2_000_000;

// Abuse-prevention rate limit (sliding 60s window), per account.
export const DEFAULT_RATE_LIMIT_PER_MIN = 10;

// Per-request token safety cap. The request path uses a conservative bound:
// UTF-8 input bytes + per-message framing + DEFAULT_MAX_TOKENS (the completion
// ceiling). 55_000 keeps the default ASCII/code-ish input budget near 50 KB
// while still rejecting dense multibyte input or many tiny messages before they
// ever reach Anthropic.
export const DEFAULT_MAX_TOKENS_PER_REQUEST = 55_000;

// Enforcement mode. "soft" meters and reports but never blocks on quota (only the
// rate limit and safety cap are hard); "hard" also blocks over-limit drafts (429).
export type EnforcementMode = "soft" | "hard";
export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = "soft";

// ---------------------------------------------------------------------------
// 56b — margin dashboard.
// ---------------------------------------------------------------------------

// Workers Analytics Engine dataset name (must match the binding in wrangler.jsonc).
export const USAGE_DATASET = "sentwise_usage";

// Assumed per-active-account monthly revenue, for margin math on /admin/margin.
export const ASSUMED_MONTHLY_REVENUE_USD = 19;

// Cost table (USD per 1M tokens). Sonnet 4.6 is the default row. Easily editable:
// add a row per model id the proxy may forward to. Source: Anthropic list pricing.
export interface ModelCost {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}
export const MODEL_COSTS: Record<string, ModelCost> = {
  "claude-sonnet-4-6": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
};
export const DEFAULT_MODEL_COST: ModelCost = MODEL_COSTS[DEFAULT_MODEL] ?? {
  inputPerMTokUsd: 3,
  outputPerMTokUsd: 15,
};

// ---------------------------------------------------------------------------
// 56c — checkout + licensing (Paddle).
// ---------------------------------------------------------------------------

// Paddle REST bases. We default to SANDBOX everywhere until the owner flips
// PADDLE_API_BASE to the live base and wires live secrets.
export const PADDLE_SANDBOX_API_BASE = "https://sandbox-api.paddle.com";
export const PADDLE_LIVE_API_BASE = "https://api.paddle.com";

// Webhook signature freshness window. Paddle's own SDK helpers default to a very
// tight 5s tolerance; a serverless webhook with clock skew + provider retries
// needs more headroom, and idempotency guards (not the clock) are our real replay
// defense. Tunable via PADDLE_WEBHOOK_TOLERANCE_SEC.
export const DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC = 300;

// The three paid launch tiers. "team" is reserved (no price mapped yet).
export type PaidPlan = "starter" | "pro" | "unlimited";

// Paddle price id -> paid tier. SANDBOX price ids (owner swaps for live ids when
// flipping PADDLE_API_BASE to the live base). The *plan* is stable; the tier's
// weekly draft limit is resolved from a var at runtime (see PLAN_DRAFT_LIMIT_VAR
// / resolvePlanDraftLimit in src/paddle.ts) so it stays tunable without a release.
export const PRICE_TO_PLAN: Record<string, PaidPlan> = {
  pri_01m1syd7nfarp8pggpcnvjbgyy: "starter",
  pri_01m1symsxarc4c3jdea0ntb09w: "pro",
  pri_01m1syrdg05f49kz705gbzn6tz: "unlimited",
};

// Per-tier weekly draft limit PLACEHOLDER defaults. These are deliberately not
// "final" numbers — the window unit (weekly vs. monthly) and real per-tier caps
// are an open owner decision (see the 56c note in docs/backlog.md). Overridable
// per-deploy via the STARTER/PRO/UNLIMITED_DRAFT_LIMIT vars.
export const DEFAULT_STARTER_DRAFT_LIMIT = 30;
export const DEFAULT_PRO_DRAFT_LIMIT = 120;
export const DEFAULT_UNLIMITED_DRAFT_LIMIT = 100_000; // fair-use ceiling, not "infinite"

// Default drafts credited per unit of the configured overage price.
export const DEFAULT_EXTRA_DRAFTS_PER_UNIT = 1;
