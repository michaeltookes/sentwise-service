// Complimentary entitlement (app-repo backlog item 111) — non-billable
// internal/QA accounts. Pure, I/O-free derivation: no storage, no network, no
// Clerk. The admin route (src/admin-comp.ts) writes the comp record into Clerk
// `privateMetadata.comp`; this module validates it and layers it over the
// account's natural subscription state at read time.
//
// Layering contract (grant must never clobber real billing state):
//   - The comp lives under its own `privateMetadata.comp` key. It never touches
//     `privateMetadata.subscription` (Paddle's record) or `privateMetadata.quota`
//     (webhook-managed limits).
//   - A real paid subscription WINS: while the stored subscription grants paid
//     access (active/trialing/past_due on a paid plan), the comp is inert.
//   - Otherwise an unexpired comp presents as an active paid plan of the granted
//     tier — indistinguishable from paid on /v1/me — with `renewsAt` set to the
//     comp expiry.
//   - Expiry is lazy: an expired comp simply stops applying on the next read;
//     the account reverts to its natural trial/Paddle state. No cron needed.
//
// PRIVACY: handles only plan enums and ISO timestamps — never prompt or draft
// content.

import type { PaidPlan } from "./config";
import { hasPaidAccess, type Subscription } from "./subscription";

/** Default comp lifetime when the grant does not specify one. */
export const COMP_DEFAULT_DAYS = 90;
/** Upper bound on a grant's lifetime (guards against typo'd immortal comps). */
export const COMP_MAX_DAYS = 3650;

/** The validated shape of `privateMetadata.comp`. */
export interface CompEntitlement {
  plan: PaidPlan;
  grantedAt: string | null; // ISO 8601, informational
  expiresAt: string; // ISO 8601 — required; comps always expire
}

/** Only the three sold tiers are grantable. `team` is reserved — never comped. */
export function isCompPlan(value: unknown): value is PaidPlan {
  return value === "starter" || value === "pro" || value === "unlimited";
}

function validIso(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return null;
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== v ? null : v;
}

/**
 * Parse `privateMetadata.comp` (untrusted-ish) into a CompEntitlement, or null
 * when absent/malformed. `plan` and `expiresAt` are required — garbage in either
 * makes the whole record absent (the account just stays in its natural state);
 * a bad `grantedAt` is dropped to null rather than poisoning the record.
 */
export function parseCompEntitlement(raw: unknown): CompEntitlement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isCompPlan(r.plan)) return null;
  const expiresAt = validIso(r.expiresAt);
  if (!expiresAt) return null;
  return {
    plan: r.plan,
    grantedAt: validIso(r.grantedAt),
    expiresAt,
  };
}

/** True while the comp has not lapsed (strictly before the expiry instant). */
export function compIsActive(comp: CompEntitlement, now: number): boolean {
  return now < Date.parse(comp.expiresAt);
}

export interface CompLayerResult {
  subscription: Subscription;
  /** True when the reported subscription is comp-derived (no real paid access). */
  compApplied: boolean;
}

/**
 * Layer a comp over the account's naturally derived subscription.
 *
 *   - No comp, or an expired one          -> natural state unchanged.
 *   - Real paid subscription active-ish   -> real subscription wins, comp inert.
 *   - Otherwise                           -> the comp presents as an ACTIVE paid
 *     plan of the granted tier. The wire shape is identical to a paid plan
 *     (deliberately indistinguishable — the app needs no changes); `renewsAt`
 *     carries the comp expiry.
 */
export function applyCompEntitlement(
  natural: Subscription,
  comp: CompEntitlement | null,
  now: number,
): CompLayerResult {
  if (!comp || !compIsActive(comp, now)) {
    return { subscription: natural, compApplied: false };
  }
  if (hasPaidAccess(natural)) {
    return { subscription: natural, compApplied: false };
  }
  return {
    subscription: {
      plan: comp.plan,
      status: "active",
      renewsAt: comp.expiresAt,
      manageBillingUrl: null,
    },
    compApplied: true,
  };
}
