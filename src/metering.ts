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
  DEFAULT_MONTHLY_DRAFT_LIMIT,
  DEFAULT_MONTHLY_TOKEN_LIMIT,
  DEFAULT_MODEL_COST,
  MODEL_COSTS,
  type EnforcementMode,
} from "./config";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RATE_WINDOW_MS = 60_000;
export const RESERVATION_TTL_MS = 15 * 60_000;
export const CONSERVATIVE_MESSAGE_FRAMING_TOKENS = 16;

export interface ReservationRecord {
  id: string;
  estimatedTokens: number;
  expiresAt: number;
}

/** Per-account monthly window state. Stored in the Durable Object. No content. */
export interface WindowState {
  windowStart: number; // ms epoch of the 1st of the month 00:00 UTC for the current window
  resetsAt: number; // ms epoch when the window rolls (the 1st of the next month 00:00 UTC)
  draftsUsed: number;
  tokensUsed: number;
  tokensReserved?: number; // in-flight estimated tokens reserved until settlement/release
  activeReservations?: ReservationRecord[];
  settledReservationIds?: string[]; // legacy in-window cache; DO marker keys are authoritative
}

/** Per-account overrides read from Clerk `privateMetadata.quota` (56c writes these). */
export interface QuotaOverride {
  monthlyDraftLimit?: number;
  monthlyTokenLimit?: number;
  extraDrafts?: number; // purchased overage added only when extraDraftsWindowStart matches
  extraDraftsWindowStart?: number; // ms epoch of the month window this purchase belongs to
}

/** Resolved effective limits for one request (env defaults + per-account overrides). */
export interface ResolvedLimits {
  monthlyDraftLimit: number; // already includes extraPurchased
  monthlyTokenLimit: number;
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
  MONTHLY_DRAFT_LIMIT?: string | number;
  MONTHLY_TOKEN_LIMIT?: string | number;
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

/**
 * Effective enforcement mode for a request (S-M2, security pass 2026-09-13).
 *
 * Trial accounts are ALWAYS hard-enforced regardless of ENFORCEMENT_MODE: a free,
 * throwaway trial account must not be able to run unbounded Anthropic spend past
 * its monthly caps. Paid tiers keep honoring the configured env-var mode — the 56b
 * measure-first ("soft") decision stands for accounts that are actually billed.
 *
 * `hasPaidAccess` is the paid-vs-trial signal (see hasPaidAccess in src/auth.ts).
 */
export function effectiveEnforcement(
  configured: EnforcementMode,
  hasPaidAccess: boolean,
): EnforcementMode {
  return hasPaidAccess ? configured : "hard";
}

/** Safely parse `privateMetadata.quota` (untrusted-ish) into a QuotaOverride. */
export function parseQuotaOverride(raw: unknown): QuotaOverride {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: QuotaOverride = {};
  // Prefer the current monthly keys; fall back to the legacy weekly keys so any
  // Clerk metadata written before the weekly->monthly switch still resolves.
  const draftLimit = r.monthlyDraftLimit ?? r.weeklyDraftLimit;
  if (typeof draftLimit === "number" && draftLimit >= 0) {
    out.monthlyDraftLimit = Math.floor(draftLimit);
  }
  const tokenLimit = r.monthlyTokenLimit ?? r.weeklyTokenLimit;
  if (typeof tokenLimit === "number" && tokenLimit >= 0) {
    out.monthlyTokenLimit = Math.floor(tokenLimit);
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
    override.monthlyDraftLimit ?? numFrom(env.MONTHLY_DRAFT_LIMIT, DEFAULT_MONTHLY_DRAFT_LIMIT);
  return {
    monthlyDraftLimit: baseDraftLimit + extraPurchased,
    monthlyTokenLimit:
      override.monthlyTokenLimit ?? numFrom(env.MONTHLY_TOKEN_LIMIT, DEFAULT_MONTHLY_TOKEN_LIMIT),
    rateLimitPerMin: numFrom(env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN),
    maxTokensPerRequest: numFrom(env.MAX_TOKENS_PER_REQUEST, DEFAULT_MAX_TOKENS_PER_REQUEST),
    enforcement: parseEnforcement(env.ENFORCEMENT_MODE),
    extraPurchased,
  };
}

// ---------------------------------------------------------------------------
// Window computation — a single, explicit definition of the metering window.
//
// The quota window is a CALENDAR MONTH in UTC: it starts at 00:00:00.000 UTC on
// the 1st and resets at 00:00:00.000 UTC on the 1st of the following month
// (owner decision 2026-09-16; the marketed per-tier caps are monthly — see
// docs/tier-matrix.md in the app repo). Months are not a fixed number of ms, so
// resets are computed from the calendar rather than by adding a constant. All
// UTC, so it is DST-irrelevant.
// ---------------------------------------------------------------------------

/** 00:00:00.000 UTC on the 1st of the month containing `now`. */
export function windowStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** 00:00:00.000 UTC on the 1st of the month AFTER the one containing `now`. */
export function windowResetsAt(now: number): number {
  const d = new Date(now);
  // Date.UTC normalizes a month index of 12 to January of the next year.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** True when `state` is exactly the calendar-month window that contains `now`. */
export function isCurrentWindow(state: WindowState, now: number): boolean {
  return state.windowStart === windowStartUtc(now) && state.resetsAt === windowResetsAt(now);
}

/** A brand-new zeroed window for the calendar month containing `now`. */
export function freshWindow(now: number): WindowState {
  return {
    windowStart: windowStartUtc(now),
    resetsAt: windowResetsAt(now),
    draftsUsed: 0,
    tokensUsed: 0,
    tokensReserved: 0,
    activeReservations: [],
    settledReservationIds: [],
  };
}

/**
 * Return the current window, rolling to a fresh one when needed.
 *
 * Rolls when there is no stored state, when `now` is at/after the stored reset,
 * OR when the stored window is not the calendar-month window for `now`. The last
 * condition makes the weekly->monthly migration clean: a record whose boundaries
 * were computed under the old weekly scheme is never aligned to a month, so the
 * first request after deploy rolls it into a fresh monthly window (usage resets —
 * acceptable pre-launch) with no crash or stuck state.
 */
export function rollWindow(state: WindowState | undefined | null, now: number): WindowState {
  if (!state || now >= state.resetsAt || !isCurrentWindow(state, now)) return freshWindow(now);
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

/** Rough token estimate: input chars/4 + the completion ceiling. */
export function estimateRequestTokens(contentChars: number, maxTokens: number): number {
  return Math.ceil(contentChars / 4) + maxTokens;
}

/**
 * Conservative request bound: UTF-8 input bytes + completion ceiling + chat framing.
 *
 * The content byte count bounds tokenizer output for user-controlled text, while
 * the per-message allowance keeps many tiny messages from bypassing the cap.
 */
export function conservativeRequestTokenBound(
  contentBytes: number,
  maxTokens: number,
  framingItems = 0,
): number {
  return contentBytes + maxTokens + framingItems * CONSERVATIVE_MESSAGE_FRAMING_TOKENS;
}

/** Build the exact `quota` wire object from window state + resolved limits. */
export function buildQuota(state: WindowState, limits: ResolvedLimits): Quota {
  return {
    unit: "drafts",
    used: state.draftsUsed,
    limit: limits.monthlyDraftLimit,
    remaining: Math.max(0, limits.monthlyDraftLimit - state.draftsUsed),
    resetsAt: new Date(state.resetsAt).toISOString(),
    tokensUsed: state.tokensUsed,
    tokenLimit: limits.monthlyTokenLimit,
    enforcement: limits.enforcement,
    extraPurchased: limits.extraPurchased,
  };
}

/** True when the account is at/over either monthly cap (drafts or tokens). */
export function isOverQuota(state: WindowState, limits: ResolvedLimits): boolean {
  return (
    state.draftsUsed >= limits.monthlyDraftLimit || state.tokensUsed >= limits.monthlyTokenLimit
  );
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
    state.draftsUsed + draftDelta > limits.monthlyDraftLimit ||
    state.tokensUsed + reservedTokens(state) + tokensReservedDelta > limits.monthlyTokenLimit
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
