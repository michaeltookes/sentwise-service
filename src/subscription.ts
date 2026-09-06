// Pure, I/O-free subscription derivation (backlog item 73). Deterministic and
// trivially unit-testable — no storage, no network, no Clerk.
//
// The subscription reported to the app is DERIVED from the 14-day trial, unless
// the Clerk user's `privateMetadata.subscription` carries a valid record. 56c
// (Paddle checkout / licensing) writes that record on checkout — see
// src/paddle.ts + src/paddle-webhook.ts. This module owns both the validation of
// that override and the trial-derived fallback.
//
// PRIVACY: handles only plan/status enums and an ISO timestamp — never prompt or
// draft content.

import type { TrialState } from "./trial";

// Launch tiers (56c). "trial" is the pre-purchase state; the three paid tiers
// map from Paddle price ids (see PRICE_TO_PLAN in config.ts); "team" is reserved
// for a future seat-based plan (unused today); "none" is the no-subscription
// terminal state. A clean pre-release break replaced the old "individual" tier —
// no released builds existed, so there is no migration.
export type SubscriptionPlan = "trial" | "starter" | "pro" | "unlimited" | "team" | "none";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "lapsed";

/** The exact `subscription` object returned on GET /v1/me. Field names are the wire contract. */
export interface Subscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  renewsAt: string | null; // ISO 8601, or null
  manageBillingUrl: string | null; // Reserved for compatibility; portal links are fetched on demand.
}

const PLANS: readonly SubscriptionPlan[] = ["trial", "starter", "pro", "unlimited", "team", "none"];
const STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "lapsed",
];

function isPlan(v: unknown): v is SubscriptionPlan {
  return typeof v === "string" && (PLANS as readonly string[]).includes(v);
}

function isStatus(v: unknown): v is SubscriptionStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

function validIso(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return null;

  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== v ? null : v;
}

/**
 * Parse `privateMetadata.subscription` (untrusted-ish) into a Subscription, or
 * return null when it is absent or malformed. Every field is validated against
 * its enum / type; `plan` and `status` are required (garbage in either makes the
 * whole record absent), while a bad `renewsAt` is dropped to null rather than
 * poisoning an otherwise-valid record. Paddle billing-management URLs are
 * temporary, so any legacy stored URL is ignored.
 */
export function parseSubscriptionOverride(raw: unknown): Subscription | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isPlan(r.plan) || !isStatus(r.status)) return null;
  return {
    plan: r.plan,
    status: r.status,
    renewsAt: validIso(r.renewsAt),
    manageBillingUrl: null,
  };
}

/**
 * Derive the account's subscription. Uses a valid `privateMetadata.subscription`
 * override when present (56c writes this on checkout); otherwise derives a
 * placeholder from the trial:
 *   - trial not yet started -> { plan: "trial", status: "trialing", renewsAt: null }
 *   - trial active          -> { plan: "trial", status: "trialing", renewsAt: endsAt }
 *   - trial expired         -> { plan: "trial", status: "lapsed",   renewsAt: endsAt }
 * `manageBillingUrl` is always null; clients should open billing management via
 * the on-demand Paddle redirect endpoint.
 */
export function deriveSubscription(trial: TrialState, rawSubscription: unknown): Subscription {
  const override = parseSubscriptionOverride(rawSubscription);
  if (override) return override;

  if (!trial.startedAt) {
    // Trial not started (viewing the account before the first draft).
    return { plan: "trial", status: "trialing", renewsAt: null, manageBillingUrl: null };
  }
  return {
    plan: "trial",
    status: trial.active ? "trialing" : "lapsed",
    renewsAt: trial.endsAt || null,
    manageBillingUrl: null,
  };
}
