// POST /v1/paddle/webhook handler (56c — checkout + licensing). Verifies the
// Paddle signature, maps the billing event to a Clerk user, and writes the
// entitlement into that user's `privateMetadata` so item 73 (subscription on
// /v1/me) and 56b (quota enforcement) pick it up. All the pure logic lives in
// src/paddle.ts; this file owns the Clerk + Paddle-API I/O.
//
// PRIVACY: this endpoint handles only plan/status/timestamps and price/
// subscription/customer ids (plus a customer email used solely to match an
// account when the checkout did not attach a Clerk user id). It never sees,
// logs, or stores prompt or draft content, and it never logs the raw webhook
// body.

import { createClerkClient } from "@clerk/backend";
import { DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC, type Env } from "./config";
import { ApiError } from "./errors";
import { numFrom } from "./metering";
import { fetchPaddleCustomerEmail } from "./paddle-api";
import {
  adjustedTransactionIdFromEvent,
  adjustmentIdFromEvent,
  clerkUserIdFromEvent,
  customerIdFromEvent,
  HANDLED_EVENT_TYPES,
  isAdjustmentEvent,
  isSubscriptionEvent,
  isApprovedOverageReversal,
  overageDraftsFromEvent,
  parsePaddleEvent,
  transactionIdFromEvent,
  verifyPaddleSignature,
  type PaddleEvent,
} from "./paddle";
import {
  quotaRecordPaddleOverage,
  quotaRecordPaddleOverageReversal,
  quotaRecordPaddleSubscription,
} from "./quota-client";

const HANDLED = new Set<string>(HANDLED_EVENT_TYPES);

/**
 * Handle a Paddle webhook. Signature is verified against the exact raw body;
 * anything that fails verification is rejected with 401 and never processed. A
 * verified-but-unactionable event (unhandled type, unknown price, unmatched
 * account, replay, non-overage transaction) is acknowledged 200 so Paddle does
 * not retry pointlessly. Transient Clerk failures surface as 5xx so Paddle retries.
 */
export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  const toleranceSec = numFrom(
    env.PADDLE_WEBHOOK_TOLERANCE_SEC,
    DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC,
  );
  const verification = await verifyPaddleSignature(
    rawBody,
    request.headers.get("Paddle-Signature") ?? request.headers.get("paddle-signature"),
    env.PADDLE_WEBHOOK_SECRET,
    Date.now(),
    toleranceSec,
  );
  if (!verification.ok) {
    // Never leak which check failed beyond a coarse reason; never process.
    throw new ApiError(401, "invalid_signature", "Webhook signature verification failed.");
  }

  const event = parsePaddleEvent(rawBody);
  if (!event) {
    throw new ApiError(400, "invalid_request", "Malformed webhook payload.");
  }

  if (!HANDLED.has(event.eventType)) {
    return ack({ ignored: "unhandled_event_type" });
  }

  if (isAdjustmentEvent(event.eventType) && !isApprovedOverageReversal(event)) {
    return ack({ ignored: "adjustment_not_reversal" });
  }

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  // Resolve the Clerk user: custom_data.clerkUserId (primary), else email match.
  const userId = await resolveClerkUserId(event, env, clerk);
  if (!userId) {
    return ack({ mapped: false });
  }

  if (isSubscriptionEvent(event.eventType)) {
    return await applySubscriptionEvent(event, env, userId);
  }
  if (isAdjustmentEvent(event.eventType)) {
    return await applyOverageReversalEvent(event, env, userId);
  }
  // transaction.completed → overage credit.
  return await applyOverageEvent(event, env, userId);
}

// ---------------------------------------------------------------------------
// Subscription lifecycle → subscription record + per-tier quota limit.
// ---------------------------------------------------------------------------

async function applySubscriptionEvent(
  event: PaddleEvent,
  env: Env,
  userId: string,
): Promise<Response> {
  try {
    const result = await quotaRecordPaddleSubscription(env, userId, {
      now: Date.now(),
      event,
    });
    return ack(result);
  } catch (err) {
    if (err instanceof ApiError && err.type === "account_deleted") {
      return ack({ mapped: false });
    }
    if (err instanceof ApiError && err.type === "account_deletion_in_progress") {
      throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// transaction.completed → extra drafts stamped to the current weekly window.
// ---------------------------------------------------------------------------

async function applyOverageEvent(event: PaddleEvent, env: Env, userId: string): Promise<Response> {
  const credit = overageDraftsFromEvent(event, env);
  if (credit <= 0) {
    // Most transaction.completed events are subscription renewals, not overage.
    return ack({ ignored: "not_overage" });
  }

  try {
    const transactionId = transactionIdFromEvent(event);
    if (!transactionId) {
      return ack({ ignored: "missing_transaction_id" });
    }
    const result = await quotaRecordPaddleOverage(env, userId, {
      now: Date.now(),
      eventId: event.eventId,
      transactionId,
      customerId: customerIdFromEvent(event),
      extraDrafts: credit,
    });
    return ack(result);
  } catch (err) {
    if (err instanceof ApiError && err.type === "account_deleted") {
      return ack({ mapped: false });
    }
    if (err instanceof ApiError && err.type === "account_deletion_in_progress") {
      throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// adjustment.* → revoke refunded/charged-back overage credit.
// ---------------------------------------------------------------------------

async function applyOverageReversalEvent(
  event: PaddleEvent,
  env: Env,
  userId: string,
): Promise<Response> {
  const adjustmentId = adjustmentIdFromEvent(event);
  const transactionId = adjustedTransactionIdFromEvent(event);
  if (!adjustmentId || !transactionId) {
    return ack({ ignored: "missing_adjustment_reference" });
  }

  try {
    const result = await quotaRecordPaddleOverageReversal(env, userId, {
      now: Date.now(),
      eventId: event.eventId,
      adjustmentId,
      transactionId,
      customerId: customerIdFromEvent(event),
    });
    return ack(result);
  } catch (err) {
    if (err instanceof ApiError && err.type === "account_deleted") {
      return ack({ mapped: false });
    }
    if (err instanceof ApiError && err.type === "account_deletion_in_progress") {
      throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Clerk user resolution.
// ---------------------------------------------------------------------------

async function resolveClerkUserId(
  event: PaddleEvent,
  env: Env,
  clerk: ReturnType<typeof createClerkClient>,
): Promise<string | null> {
  const fromCustomData = clerkUserIdFromEvent(event);
  if (fromCustomData) return fromCustomData;

  // Fallback: look the customer's email up in Clerk.
  const customerId = customerIdFromEvent(event);
  if (!customerId) return null;
  const email = await fetchPaddleCustomerEmail(env, customerId);
  if (!email) return null;
  try {
    const list: unknown = await clerk.users.getUserList({ emailAddress: [email] });
    const rec = asRecord(list);
    const arr = Array.isArray(rec?.data) ? rec.data : Array.isArray(list) ? list : [];
    const firstId = asRecord(arr[0])?.id;
    return typeof firstId === "string" ? firstId : null;
  } catch {
    throw new ApiError(502, "account_lookup_failed", "Could not resolve the account.");
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Acknowledge a verified event. The body carries only a coarse outcome tag. */
function ack(extra: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...extra });
}
