// Pure, I/O-free metering logic (56b). Everything here is deterministic and
// trivially unit-testable — no storage, no network, no Clerk. The Durable Object
// (src/quota-do.ts) and the request handler (src/index.ts) call into these.
//
// PRIVACY: this module handles only counters, timestamps, random reservation IDs,
// and limits. It never sees prompt or draft content.

import {
  DEFAULT_ENFORCEMENT_MODE,
  DEFAULT_MAX_TOKENS_PER_REQUEST,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_WEEKLY_DRAFT_LIMIT,
  DEFAULT_WEEKLY_TOKEN_LIMIT,
  DEFAULT_MODEL_COST,
  MODEL_COSTS,
  type EnforcementMode,
} from "./config";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const RATE_WINDOW_MS = 60_000;
export const RESERVATION_TTL_MS = 15 * 60_000;
export const MAX_SETTLED_RESERVATION_IDS = 128;

export interface ReservationRecord {
  id: string;
  estimatedTokens: number;
  expiresAt: number;
}

/** Per-account weekly window state. Stored in the Durable Object. No content. */
export interface WindowState {
  windowStart: number; // ms epoch of Monday 00:00 UTC for the current window
  resetsAt: number; // ms epoch when the window rolls (windowStart + WEEK_MS)
  draftsUsed: number;
  tokensUsed: number;
  tokensReserved?: number; // in-flight estimated tokens reserved until settlement/release
  activeReservations?: ReservationRecord[];
  settledReservationIds?: string[]; // bounded random UUIDs used only to dedupe settlement retries
}

/** Per-account overrides read from Clerk `privateMetadata.quota` (56c writes these). */
export interface QuotaOverride {
  weeklyDraftLimit?: number;
  weeklyTokenLimit?: number;
  extraDrafts?: number; // purchased overage added only when extraDraftsWindowStart matches
  extraDraftsWindowStart?: number; // ms epoch of the Monday window this purchase belongs to
}

/** Resolved effective limits for one request (env defaults + per-account overrides). */
export interface ResolvedLimits {
  weeklyDraftLimit: number; // already includes extraPurchased
  weeklyTokenLimit: number;
  rateLimitPerMin: number;
  maxTokensPerRequest: number;
  enforcement: EnforcementMode;
  extraPurchased: number;
}

/** The exact `quota` object returned on /v1/draft and /v1/me. Field names are the wire contract. */
export interface Quota {
  unit: "drafts";
  used: number;
  limit: number;
  remaining: number; // clamped at 0
  resetsAt: string; // ISO 8601
  tokensUsed: number;
  tokenLimit: number;
  enforcement: EnforcementMode;
  extraPurchased: number;
}

/** Structural subset of Env needed to resolve limits (keeps this module I/O-free & testable). */
export interface LimitEnv {
  WEEKLY_DRAFT_LIMIT?: string | number;
  WEEKLY_TOKEN_LIMIT?: string | number;
  RATE_LIMIT_PER_MIN?: string | number;
  MAX_TOKENS_PER_REQUEST?: string | number;
  ENFORCEMENT_MODE?: string;
}

/** Coerce a wrangler var (string or number) to a finite number, else fall back. */
export function numFrom(v: string | number | undefined, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function parseEnforcement(v: string | undefined): EnforcementMode {
  if (v === "hard") return "hard";
  if (v === "soft") return "soft";
  return DEFAULT_ENFORCEMENT_MODE;
}

/** Safely parse `privateMetadata.quota` (untrusted-ish) into a QuotaOverride. */
export function parseQuotaOverride(raw: unknown): QuotaOverride {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: QuotaOverride = {};
  if (typeof r.weeklyDraftLimit === "number" && r.weeklyDraftLimit >= 0) {
    out.weeklyDraftLimit = Math.floor(r.weeklyDraftLimit);
  }
  if (typeof r.weeklyTokenLimit === "number" && r.weeklyTokenLimit >= 0) {
    out.weeklyTokenLimit = Math.floor(r.weeklyTokenLimit);
  }
  if (typeof r.extraDrafts === "number" && r.extraDrafts >= 0) {
    out.extraDrafts = Math.floor(r.extraDrafts);
  }
  if (typeof r.extraDraftsWindowStart === "number" && r.extraDraftsWindowStart >= 0) {
    out.extraDraftsWindowStart = Math.floor(r.extraDraftsWindowStart);
  }
  return out;
}

/** Combine env defaults with per-account overrides into the effective limits. */
export function resolveLimits(
  env: LimitEnv,
  override: QuotaOverride,
  windowStart?: number,
): ResolvedLimits {
  const extraPurchased =
    override.extraDraftsWindowStart === windowStart ? (override.extraDrafts ?? 0) : 0;
  const baseDraftLimit =
    override.weeklyDraftLimit ?? numFrom(env.WEEKLY_DRAFT_LIMIT, DEFAULT_WEEKLY_DRAFT_LIMIT);
  return {
    weeklyDraftLimit: baseDraftLimit + extraPurchased,
    weeklyTokenLimit:
      override.weeklyTokenLimit ?? numFrom(env.WEEKLY_TOKEN_LIMIT, DEFAULT_WEEKLY_TOKEN_LIMIT),
    rateLimitPerMin: numFrom(env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN),
    maxTokensPerRequest: numFrom(env.MAX_TOKENS_PER_REQUEST, DEFAULT_MAX_TOKENS_PER_REQUEST),
    enforcement: parseEnforcement(env.ENFORCEMENT_MODE),
    extraPurchased,
  };
}

/** Monday 00:00:00.000 UTC of the week containing `now`. */
export function mondayStartUtc(now: number): number {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (day + 6) % 7; // Monday -> 0, Sunday -> 6
  const midnightToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnightToday - daysSinceMonday * DAY_MS;
}

/** A brand-new zeroed window for the week containing `now`. */
export function freshWindow(now: number): WindowState {
  const windowStart = mondayStartUtc(now);
  return {
    windowStart,
    resetsAt: windowStart + WEEK_MS,
    draftsUsed: 0,
    tokensUsed: 0,
    tokensReserved: 0,
    activeReservations: [],
    settledReservationIds: [],
  };
}

/** Return the current window, rolling to a fresh one if `now` is at/after reset. */
export function rollWindow(state: WindowState | undefined | null, now: number): WindowState {
  if (!state || now >= state.resetsAt) return freshWindow(now);
  return pruneExpiredReservations(normalizeWindow(state), now);
}

/** Drop rate-limit timestamps older than the sliding window. */
export function pruneStamps(
  stamps: number[],
  now: number,
  windowMs: number = RATE_WINDOW_MS,
): number[] {
  const cutoff = now - windowMs;
  return stamps.filter((t) => t > cutoff);
}

/** Rough token estimate for the safety cap: input chars/4 + the completion ceiling. */
export function estimateRequestTokens(contentChars: number, maxTokens: number): number {
  return Math.ceil(contentChars / 4) + maxTokens;
}

/** Conservative hard-quota bound: UTF-8 input bytes + the completion ceiling. */
export function conservativeRequestTokenBound(contentBytes: number, maxTokens: number): number {
  return contentBytes + maxTokens;
}

/** Build the exact `quota` wire object from window state + resolved limits. */
export function buildQuota(state: WindowState, limits: ResolvedLimits): Quota {
  return {
    unit: "drafts",
    used: state.draftsUsed,
    limit: limits.weeklyDraftLimit,
    remaining: Math.max(0, limits.weeklyDraftLimit - state.draftsUsed),
    resetsAt: new Date(state.resetsAt).toISOString(),
    tokensUsed: state.tokensUsed,
    tokenLimit: limits.weeklyTokenLimit,
    enforcement: limits.enforcement,
    extraPurchased: limits.extraPurchased,
  };
}

/** True when the account is at/over either weekly cap (drafts or tokens). */
export function isOverQuota(state: WindowState, limits: ResolvedLimits): boolean {
  return state.draftsUsed >= limits.weeklyDraftLimit || state.tokensUsed >= limits.weeklyTokenLimit;
}

export function reservedTokens(state: WindowState): number {
  return state.tokensReserved ?? 0;
}

export function activeReservations(state: WindowState): ReservationRecord[] {
  return state.activeReservations ?? [];
}

export function pruneExpiredReservations(state: WindowState, now: number): WindowState {
  const active = activeReservations(state);
  const kept = active.filter((r) => r.expiresAt > now);
  if (kept.length === active.length) return state;
  return {
    ...state,
    draftsUsed: Math.max(0, state.draftsUsed - (active.length - kept.length)),
    tokensReserved: kept.reduce((sum, r) => sum + r.estimatedTokens, 0),
    activeReservations: kept,
  };
}

export function wouldExceedQuota(
  state: WindowState,
  limits: ResolvedLimits,
  draftDelta: number,
  tokensReservedDelta: number,
): boolean {
  return (
    state.draftsUsed + draftDelta > limits.weeklyDraftLimit ||
    state.tokensUsed + reservedTokens(state) + tokensReservedDelta > limits.weeklyTokenLimit
  );
}

function normalizeWindow(state: WindowState): WindowState {
  const active = state.activeReservations ?? [];
  return {
    ...state,
    tokensReserved: active.reduce((sum, r) => sum + r.estimatedTokens, 0),
    activeReservations: active,
    settledReservationIds: state.settledReservationIds ?? [],
  };
}

/** Estimated USD cost of one draft, from the model's cost-table row. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const c = MODEL_COSTS[model] ?? DEFAULT_MODEL_COST;
  return (
    (inputTokens / 1_000_000) * c.inputPerMTokUsd + (outputTokens / 1_000_000) * c.outputPerMTokUsd
  );
}
