// Pure, I/O-free subscription derivation (backlog item 73). Deterministic and
// trivially unit-testable — no storage, no network, no Clerk.
//
// PLACEHOLDER until 56c (Paddle checkout / licensing) ships. Until then the
// subscription reported to the app is DERIVED from the 14-day trial, unless the
// Clerk user's `privateMetadata.subscription` already carries a valid record
// (which 56c will write on checkout). This module owns both the validation of
// that override and the trial-derived fallback.
//
// PRIVACY: handles only plan/status enums, an ISO timestamp, and a billing URL —
// never prompt or draft content.

import type { TrialState } from "./trial";

export type SubscriptionPlan = "trial" | "individual" | "team" | "none";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "lapsed";

/** The exact `subscription` object returned on GET /v1/me. Field names are the wire contract. */
export interface Subscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  renewsAt: string | null; // ISO 8601, or null
  manageBillingUrl: string | null; // https URL, or null
}

const PLANS: readonly SubscriptionPlan[] = ["trial", "individual", "team", "none"];
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

function validHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Parse `privateMetadata.subscription` (untrusted-ish) into a Subscription, or
 * return null when it is absent or malformed. Every field is validated against
 * its enum / type; `plan` and `status` are required (garbage in either makes the
 * whole record absent), while a bad `renewsAt` / `manageBillingUrl` is dropped to
 * null rather than poisoning an otherwise-valid record.
 */
export function parseSubscriptionOverride(raw: unknown): Subscription | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isPlan(r.plan) || !isStatus(r.status)) return null;
  return {
    plan: r.plan,
    status: r.status,
    renewsAt: validIso(r.renewsAt),
    manageBillingUrl: validHttpsUrl(r.manageBillingUrl),
  };
}

/**
 * Derive the account's subscription. Uses a valid `privateMetadata.subscription`
 * override when present (56c writes this on checkout); otherwise derives a
 * placeholder from the trial:
 *   - trial not yet started -> { plan: "trial", status: "trialing", renewsAt: null }
 *   - trial active          -> { plan: "trial", status: "trialing", renewsAt: endsAt }
 *   - trial expired         -> { plan: "trial", status: "lapsed",   renewsAt: endsAt }
 * `manageBillingUrl` is always null until 56c wires the Paddle customer portal.
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
