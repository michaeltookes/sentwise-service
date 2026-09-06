// POST /v1/paddle/webhook handler (56c — checkout + licensing). Verifies the
// Paddle signature, maps the billing event to a Clerk user, and writes the
// entitlement into that user's `privateMetadata` so item 73 (subscription on
// /v1/me) and 56b (quota enforcement) pick it up. All the pure logic lives in
// src/paddle.ts; this file owns the Clerk + Paddle-API I/O.
//
// PRIVACY: this endpoint handles only plan/status/timestamps and price/
// subscription/customer ids (plus a customer email used solely to locate a
// previously-bound account when Paddle omits checkout custom data). It never
// sees, logs, or stores prompt or draft content, and it never logs the raw
// webhook body.

import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import {
  DEFAULT_PADDLE_WEBHOOK_MAX_BODY_BYTES,
  DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC,
  type Env,
} from "./config";
import { ApiError } from "./errors";
import { mondayStartUtc, numFrom } from "./metering";
import {
  paddleCheckoutBindingMatchesCustomData,
  paddleCheckoutBindingMatchesEvent,
  paddleCustomerMatchesStoredAccount,
} from "./paddle-account";
import { fetchPaddleCustomerEmail, fetchPaddleTransactionSnapshot } from "./paddle-api";
import {
  adjustedTransactionIdFromEvent,
  adjustmentIdFromEvent,
  clerkUserIdFromCustomData,
  clerkUserIdFromEvent,
  customerIdFromEvent,
  HANDLED_EVENT_TYPES,
  isAdjustmentEvent,
  isSubscriptionEvent,
  isApprovedOverageAdjustment,
  overageAdjustmentFromEvent,
  overageCreditFromEvent,
  overageCreditFromReservedCheckout,
  parsePaddleEvent,
  transactionIdFromEvent,
  verifyPaddleSignature,
  type OverageCreditSummary,
  type PaddleEvent,
} from "./paddle";
import {
  quotaPeekPaddleOverageCheckout,
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
  const rawBody = await readWebhookBody(
    request,
    positiveIntFrom(env.PADDLE_WEBHOOK_MAX_BODY_BYTES, DEFAULT_PADDLE_WEBHOOK_MAX_BODY_BYTES),
  );

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

  if (isAdjustmentEvent(event.eventType) && !isApprovedOverageAdjustment(event)) {
    return ack({ ignored: "adjustment_not_reversal" });
  }

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  // Resolve the Clerk user: signed checkout custom data or stored-customer email fallback.
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
  try {
    const transactionId = transactionIdFromEvent(event);
    if (!transactionId) {
      return ack({ ignored: "missing_transaction_id" });
    }
    const customerId = customerIdFromEvent(event);
    const credit = await overageCreditForTransactionCompletedEvent(
      event,
      env,
      userId,
      transactionId,
      customerId,
    );
    if (credit.extraDrafts <= 0) {
      // Most transaction.completed events are subscription renewals, not overage.
      return ack({ ignored: "not_overage" });
    }
    const result = await quotaRecordPaddleOverage(env, userId, {
      now: Date.now(),
      eventWindowStart: overageEventWindowStart(event),
      eventId: event.eventId,
      transactionId,
      customerId,
      extraDrafts: credit.extraDrafts,
      credits: credit.credits,
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

async function overageCreditForTransactionCompletedEvent(
  event: PaddleEvent,
  env: Env,
  userId: string,
  transactionId: string,
  customerId: string | null,
): Promise<OverageCreditSummary> {
  const currentCatalogCredit = overageCreditFromEvent(event, env);
  if (currentCatalogCredit.extraDrafts > 0) return currentCatalogCredit;

  if (!customerId) return currentCatalogCredit;
  const reservation = await quotaPeekPaddleOverageCheckout(env, userId, { now: Date.now() });
  if (
    !reservation.pending ||
    reservation.transactionId !== transactionId ||
    reservation.customerId !== customerId ||
    !reservation.priceId ||
    !reservation.quantity ||
    !reservation.extraDrafts
  ) {
    return currentCatalogCredit;
  }

  return overageCreditFromReservedCheckout(event, {
    priceId: reservation.priceId,
    quantity: reservation.quantity,
    extraDrafts: reservation.extraDrafts,
  });
}

// ---------------------------------------------------------------------------
// adjustment.* → revoke/restore overage credit.
// ---------------------------------------------------------------------------

async function applyOverageReversalEvent(
  event: PaddleEvent,
  env: Env,
  userId: string,
): Promise<Response> {
  const adjustmentId = adjustmentIdFromEvent(event);
  const transactionId = adjustedTransactionIdFromEvent(event);
  const adjustment = overageAdjustmentFromEvent(event);
  if (!adjustmentId || !transactionId || !adjustment) {
    return ack({ ignored: "missing_adjustment_reference" });
  }

  try {
    const result = await quotaRecordPaddleOverageReversal(env, userId, {
      now: Date.now(),
      eventId: event.eventId,
      adjustmentId,
      transactionId,
      customerId: customerIdFromEvent(event),
      action: adjustment.action,
      adjustmentType: adjustment.adjustmentType,
      hasAdjustmentItems: adjustment.hasAdjustmentItems,
      items: adjustment.items,
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
  if (fromCustomData) {
    const customerId = customerIdFromEvent(event);
    if (!customerId) return null;
    let user;
    try {
      user = await clerk.users.getUser(fromCustomData);
    } catch (err) {
      if (isClerkNotFoundError(err)) return null;
      throw new ApiError(502, "account_lookup_failed", "Could not resolve the account.");
    }
    const meta = user.privateMetadata ?? {};
    if (paddleCustomerMatchesStoredAccount(meta, customerId)) return fromCustomData;
    return (await paddleCheckoutBindingMatchesEvent(event, fromCustomData, env))
      ? fromCustomData
      : null;
  }

  const customerId = customerIdFromEvent(event);
  if (!customerId) return null;

  const fromTransaction = await resolveClerkUserIdFromAdjustedTransaction(
    event,
    customerId,
    env,
    clerk,
  );
  if (fromTransaction) return fromTransaction;

  // Fallback: look the customer's email up in Clerk. The serialized writer still
  // requires the account to have this Paddle customer id already stored.
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

async function resolveClerkUserIdFromAdjustedTransaction(
  event: PaddleEvent,
  customerId: string,
  env: Env,
  clerk: ReturnType<typeof createClerkClient>,
): Promise<string | null> {
  const transactionId = adjustedTransactionIdFromEvent(event);
  if (!transactionId) return null;

  const transaction = await fetchPaddleTransactionSnapshot(env, transactionId);
  if (!transaction || transaction.customerId !== customerId || !transaction.customData) {
    return null;
  }

  const userId = clerkUserIdFromCustomData(transaction.customData);
  if (!userId) return null;
  if (!(await paddleCheckoutBindingMatchesCustomData(transaction.customData, userId, env))) {
    return null;
  }

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch (err) {
    if (isClerkNotFoundError(err)) return null;
    throw new ApiError(502, "account_lookup_failed", "Could not resolve the account.");
  }
  const meta = user.privateMetadata ?? {};
  return paddleCustomerMatchesStoredAccount(meta, customerId) ? userId : null;
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

async function readWebhookBody(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";

  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (result.done) break;
    const value = result.value;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "payload_too_large", "Webhook payload is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function positiveIntFrom(v: string | number | undefined, fallback: number): number {
  const n = Math.floor(numFrom(v, fallback));
  return n > 0 ? n : fallback;
}

function overageEventWindowStart(event: PaddleEvent): number | undefined {
  if (!event.occurredAt) return undefined;
  const occurredAt = Date.parse(event.occurredAt);
  return Number.isFinite(occurredAt) ? mondayStartUtc(occurredAt) : undefined;
}
