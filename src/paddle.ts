// Pure, I/O-free Paddle helpers (56c — checkout + licensing). Signature
// verification, webhook-event parsing, and the mapping from a Paddle event to
// the Sentwise subscription wire record + the per-tier quota limit. Everything
// here is deterministic and unit-testable: crypto is WebCrypto (no network), and
// there is no Clerk, no storage, and no logging.
//
// PRIVACY: this module handles only plan/status enums, timestamps, price/
// subscription/customer ids, and integer draft counts — never prompt or draft
// content. The webhook body it verifies carries billing metadata only.

import {
  DEFAULT_EXTRA_DRAFTS_PER_UNIT,
  DEFAULT_PRO_DRAFT_LIMIT,
  DEFAULT_STARTER_DRAFT_LIMIT,
  DEFAULT_UNLIMITED_DRAFT_LIMIT,
  PRICE_TO_PLAN,
  type PaidPlan,
} from "./config";
import { numFrom } from "./metering";
import type { SubscriptionPlan, SubscriptionStatus } from "./subscription";

// The subscription lifecycle events we act on, plus transaction overage
// purchases and adjustment reversals.
export const HANDLED_EVENT_TYPES = [
  "adjustment.created",
  "adjustment.updated",
  "subscription.activated",
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "transaction.completed",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isSubscriptionEvent(eventType: string): boolean {
  return eventType.startsWith("subscription.");
}

export function isAdjustmentEvent(eventType: string): boolean {
  return eventType === "adjustment.created" || eventType === "adjustment.updated";
}

export type OverageAdjustmentAction =
  "refund" | "chargeback" | "credit" | "chargeback_reverse" | "credit_reverse";

export interface OverageCreditItem {
  transactionItemId: string | null;
  extraDrafts: number;
  amount: number | null;
}

export interface OverageCreditSummary {
  extraDrafts: number;
  credits: OverageCreditItem[];
}

export interface OverageAdjustmentItem {
  transactionItemId: string;
  type: "full" | "partial";
  amount: number | null;
}

export interface OverageAdjustmentSummary {
  action: OverageAdjustmentAction;
  adjustmentType: string | null;
  hasAdjustmentItems: boolean;
  items: OverageAdjustmentItem[];
}

// ---------------------------------------------------------------------------
// Signature verification (Paddle "Verify webhook signatures").
// Header: `ts=<unix-seconds>;h1=<hex-hmac-sha256>` over the payload `<ts>:<rawBody>`.
// ---------------------------------------------------------------------------

export interface ParsedPaddleSignature {
  ts: number; // Unix seconds
  h1: string[]; // one or more hex HMAC-SHA256 values
}

/** Parse the `Paddle-Signature` header into its `ts` and `h1` parts, or null. */
export function parsePaddleSignatureHeader(
  header: string | null | undefined,
): ParsedPaddleSignature | null {
  if (!header) return null;
  let ts: number | null = null;
  const h1: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "ts") {
      const n = Number(val);
      if (Number.isFinite(n)) ts = n;
    } else if (key === "h1" && /^[0-9a-f]+$/i.test(val)) {
      h1.push(val);
    }
  }
  if (ts === null || h1.length === 0) return null;
  return { ts, h1 };
}

/** Constant-time compare of two equal-length hex strings. Length-mismatch is a fast false. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** HMAC-SHA256 of `message` under `secret`, hex-encoded. WebCrypto, no I/O. */
export async function computeHmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type SignatureFailure = "no_secret" | "malformed" | "stale" | "mismatch";
export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Verify a Paddle webhook signature against the exact raw body. Rejects a missing
 * secret, a malformed header, a stale timestamp (outside `toleranceSec` in either
 * direction), and a mismatched HMAC. Never throws; returns a tagged result.
 */
export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | undefined,
  now: number,
  toleranceSec: number,
): Promise<SignatureResult> {
  if (!secret) return { ok: false, reason: "no_secret" };
  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed" };
  const ageSec = Math.abs(now / 1000 - parsed.ts);
  if (ageSec > toleranceSec) return { ok: false, reason: "stale" };
  const expected = await computeHmacSha256Hex(secret, `${parsed.ts}:${rawBody}`);
  return parsed.h1.some((h1) => timingSafeEqualHex(expected, h1))
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

// ---------------------------------------------------------------------------
// Event parsing.
// ---------------------------------------------------------------------------

export interface PaddleEvent {
  eventId: string;
  eventType: string;
  occurredAt: string | null;
  data: Record<string, unknown>;
}

/** Structurally parse a webhook body. Requires event_id, event_type, and a data object. */
export function parsePaddleEvent(rawBody: string): PaddleEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  const eventId = typeof r.event_id === "string" ? r.event_id : null;
  const eventType = typeof r.event_type === "string" ? r.event_type : null;
  const data =
    typeof r.data === "object" && r.data !== null ? (r.data as Record<string, unknown>) : null;
  if (!eventId || !eventType || !data) return null;
  return {
    eventId,
    eventType,
    occurredAt: typeof r.occurred_at === "string" ? r.occurred_at : null,
    data,
  };
}

// ---------------------------------------------------------------------------
// Data extraction from the `data` object.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** `data.custom_data.clerkUserId` — the app's checkout attaches this. */
export function clerkUserIdFromEvent(event: PaddleEvent): string | null {
  const custom = asRecord(event.data.custom_data);
  const id = custom?.clerkUserId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** `data.customer_id` on a subscription/transaction. */
export function customerIdFromEvent(event: PaddleEvent): string | null {
  const id = event.data.customer_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** `data.id` on a transaction.completed event. */
export function transactionIdFromEvent(event: PaddleEvent): string | null {
  const id = event.data.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** `data.id` on an adjustment event. */
export function adjustmentIdFromEvent(event: PaddleEvent): string | null {
  const id = event.data.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** `data.transaction_id` on an adjustment event. */
export function adjustedTransactionIdFromEvent(event: PaddleEvent): string | null {
  const id = event.data.transaction_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** `data.id` — the subscription id on subscription.* events. */
export function subscriptionIdFromEvent(event: PaddleEvent): string | null {
  const id = event.data.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** All `data.items[].price.id` values, in order. */
export function priceIdsFromEvent(event: PaddleEvent): string[] {
  const items = event.data.items;
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const item of items) {
    const price = asRecord(asRecord(item)?.price);
    const id = price?.id;
    if (typeof id === "string" && id !== "") out.push(id);
  }
  return out;
}

/**
 * The paid tier for a subscription event: the first item whose price id is in
 * PRICE_TO_PLAN wins; the raw matching price id comes back too (for reconciliation).
 * Returns null when no item maps to a known tier.
 */
export function planFromEvent(event: PaddleEvent): { plan: PaidPlan; priceId: string } | null {
  for (const priceId of priceIdsFromEvent(event)) {
    const plan = PRICE_TO_PLAN[priceId];
    if (plan) return { plan, priceId };
  }
  return null;
}

/**
 * Map an event to a wire `status`. Prefers the entity's own `data.status` (the
 * source of truth), then falls back to the event type. A Paddle "paused"
 * subscription is treated as `canceled` for access purposes.
 */
export function statusFromEvent(event: PaddleEvent): SubscriptionStatus {
  const dataStatus = typeof event.data.status === "string" ? event.data.status : undefined;
  switch (dataStatus) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "paused":
      return "canceled";
  }
  switch (event.eventType) {
    case "subscription.canceled":
    case "subscription.paused":
      return "canceled";
    case "subscription.past_due":
      return "past_due";
    case "subscription.activated":
    case "subscription.resumed":
      return "active";
    default:
      return "active";
  }
}

/**
 * Whether an adjustment should revoke overage credit. Paddle creates `refund`
 * adjustments as pending in many live cases, so wait for an approved status.
 */
export function isApprovedOverageReversal(event: PaddleEvent): boolean {
  if (!isAdjustmentEvent(event.eventType)) return false;
  const action = event.data.action;
  if (action !== "refund" && action !== "chargeback" && action !== "credit") return false;
  return event.data.status === "approved";
}

export function isApprovedOverageRestore(event: PaddleEvent): boolean {
  if (!isAdjustmentEvent(event.eventType)) return false;
  const action = event.data.action;
  if (action !== "chargeback_reverse" && action !== "credit_reverse") return false;
  return event.data.status === "approved";
}

export function isApprovedOverageAdjustment(event: PaddleEvent): boolean {
  return isApprovedOverageReversal(event) || isApprovedOverageRestore(event);
}

export function overageAdjustmentFromEvent(event: PaddleEvent): OverageAdjustmentSummary | null {
  if (!isApprovedOverageAdjustment(event)) return null;
  const action = event.data.action as OverageAdjustmentAction;
  const adjustmentType = typeof event.data.type === "string" ? event.data.type : null;
  const items = Array.isArray(event.data.items) ? event.data.items : [];
  return {
    action,
    adjustmentType,
    hasAdjustmentItems: items.length > 0,
    items: items.flatMap((item): OverageAdjustmentItem[] => {
      const record = asRecord(item);
      if (!record) return [];
      const transactionItemId = record?.item_id;
      if (typeof transactionItemId !== "string" || transactionItemId === "") return [];
      const type = record.type === "partial" ? "partial" : record.type === "full" ? "full" : null;
      if (!type) return [];
      return [
        {
          transactionItemId,
          type,
          amount: parsePaddleAmount(record.amount),
        },
      ];
    }),
  };
}

/** Normalize any parseable timestamp to canonical ISO-with-millis, or null. */
export function normalizeIso(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Per-tier weekly draft limit resolution (var-driven placeholders).
// ---------------------------------------------------------------------------

export interface PlanLimitEnv {
  STARTER_DRAFT_LIMIT?: string | number;
  PRO_DRAFT_LIMIT?: string | number;
  UNLIMITED_DRAFT_LIMIT?: string | number;
}

/** Resolve a paid tier's weekly draft limit from vars, falling back to placeholders. */
export function resolvePlanDraftLimit(env: PlanLimitEnv, plan: PaidPlan): number {
  switch (plan) {
    case "starter":
      return numFrom(env.STARTER_DRAFT_LIMIT, DEFAULT_STARTER_DRAFT_LIMIT);
    case "pro":
      return numFrom(env.PRO_DRAFT_LIMIT, DEFAULT_PRO_DRAFT_LIMIT);
    case "unlimited":
      return numFrom(env.UNLIMITED_DRAFT_LIMIT, DEFAULT_UNLIMITED_DRAFT_LIMIT);
  }
}

// ---------------------------------------------------------------------------
// Overage ("buy more drafts") credit from a transaction.completed event.
// ---------------------------------------------------------------------------

export interface OverageEnv {
  EXTRA_DRAFTS_PRICE_ID?: string;
  EXTRA_DRAFTS_PER_UNIT?: string | number;
}

/**
 * How many extra drafts a `transaction.completed` event credits, or 0 when it is
 * not an overage purchase. Subscription renewals also emit transaction.completed,
 * so crediting requires the configured overage price id. The amount is derived
 * only from matching line-item quantity times EXTRA_DRAFTS_PER_UNIT (default 1);
 * buyer-supplied custom_data can tag a checkout but never controls the credit.
 */
export function overageDraftsFromEvent(event: PaddleEvent, env: OverageEnv): number {
  return overageCreditFromEvent(event, env).extraDrafts;
}

export function overageCreditFromEvent(event: PaddleEvent, env: OverageEnv): OverageCreditSummary {
  if (event.eventType !== "transaction.completed") return { extraDrafts: 0, credits: [] };

  const overagePriceId =
    typeof env.EXTRA_DRAFTS_PRICE_ID === "string" && env.EXTRA_DRAFTS_PRICE_ID !== ""
      ? env.EXTRA_DRAFTS_PRICE_ID
      : null;
  if (!overagePriceId) return { extraDrafts: 0, credits: [] };

  const perUnit = numFrom(env.EXTRA_DRAFTS_PER_UNIT, DEFAULT_EXTRA_DRAFTS_PER_UNIT);
  const credits = overageCreditItemsFromDetails(event, overagePriceId, perUnit);
  const fallbackCredits =
    credits.length > 0
      ? credits
      : overageCreditItemsFromTransactionItems(event, overagePriceId, perUnit);
  return {
    extraDrafts: fallbackCredits.reduce((sum, item) => sum + item.extraDrafts, 0),
    credits: fallbackCredits,
  };
}

function overageCreditItemsFromDetails(
  event: PaddleEvent,
  overagePriceId: string,
  perUnit: number,
): OverageCreditItem[] {
  const details = asRecord(event.data.details);
  const lineItems = Array.isArray(details?.line_items) ? details.line_items : [];
  const credits: OverageCreditItem[] = [];
  for (const item of lineItems) {
    const record = asRecord(item);
    if (record?.price_id !== overagePriceId) continue;
    const quantity = positiveInt(record.quantity) ?? 0;
    const extraDrafts = quantity * perUnit;
    if (extraDrafts <= 0) continue;
    credits.push({
      transactionItemId: typeof record.id === "string" && record.id !== "" ? record.id : null,
      extraDrafts,
      amount: transactionLineItemTotal(record, quantity),
    });
  }
  return credits;
}

function overageCreditItemsFromTransactionItems(
  event: PaddleEvent,
  overagePriceId: string,
  perUnit: number,
): OverageCreditItem[] {
  const items = Array.isArray(event.data.items) ? event.data.items : [];
  const credits: OverageCreditItem[] = [];
  for (const item of items) {
    const record = asRecord(item);
    if (asRecord(record?.price)?.id !== overagePriceId) continue;
    const quantity = positiveInt(record?.quantity) ?? 0;
    const extraDrafts = quantity * perUnit;
    if (extraDrafts <= 0) continue;
    credits.push({
      transactionItemId: typeof record?.id === "string" && record.id !== "" ? record.id : null,
      extraDrafts,
      amount: null,
    });
  }
  return credits;
}

function transactionLineItemTotal(
  record: Record<string, unknown>,
  quantity: number,
): number | null {
  const totals = asRecord(record.totals);
  const total = parsePaddleAmount(totals?.total);
  if (total !== null) return total;

  const unitTotals = asRecord(record.unit_totals);
  const unitTotal = parsePaddleAmount(unitTotals?.total);
  return unitTotal !== null ? unitTotal * quantity : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function parsePaddleAmount(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// ---------------------------------------------------------------------------
// The stored `privateMetadata.subscription` record (56c writes; item 73 reads).
// parseSubscriptionOverride reads plan/status/renewsAt; the rest is for
// reconciliation + idempotency. Billing-management URLs are fetched on demand
// because Paddle portal links are temporary.
// ---------------------------------------------------------------------------

export interface StoredSubscriptionRecord {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  renewsAt: string | null;
  manageBillingUrl: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  priceId: string | null;
  updatedAt: string;
  paddleOccurredAt: string | null;
  lastEventId: string; // idempotency guard
}

/**
 * Build the subscription record to store for a subscription.* event. `plan` and
 * `priceId` come from planFromEvent. `manageBillingUrl` is intentionally not
 * persisted; callers fetch Paddle's temporary portal URLs on demand.
 */
export function buildSubscriptionRecord(
  event: PaddleEvent,
  plan: SubscriptionPlan,
  priceId: string | null,
  now: number,
): StoredSubscriptionRecord {
  return {
    plan,
    status: statusFromEvent(event),
    renewsAt: normalizeIso(event.data.next_billed_at),
    manageBillingUrl: null,
    paddleSubscriptionId: subscriptionIdFromEvent(event),
    paddleCustomerId: customerIdFromEvent(event),
    priceId,
    updatedAt: normalizeIso(event.occurredAt) ?? new Date(now).toISOString(),
    paddleOccurredAt: event.occurredAt,
    lastEventId: event.eventId,
  };
}
