// Thin client the request handler uses to talk to the AccountQuota Durable
// Object (56b). Keeps the DO-plumbing out of src/index.ts.

import type { Env } from "./config";
import { ApiError, type ErrorExtra } from "./errors";
import type { ResolvedLimits, WindowState } from "./metering";
import type { InterestTopic } from "./interest";
import type {
  OverageAdjustmentAction,
  OverageAdjustmentItem,
  OverageCreditItem,
  PaddleEvent,
} from "./paddle";

export interface CheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  window: WindowState;
}
export interface WindowResult {
  window: WindowState;
}
export interface ReserveResult {
  reserved: boolean;
  blockedByQuota: boolean;
  reservationId: string;
  estimatedTokens: number;
  window: WindowState;
}
export interface SettleBody {
  now: number;
  reservationId?: string;
  reservationWindowStart?: number;
  estimatedTokens?: number;
  draftsDelta?: number;
  tokensDelta: number;
}
export interface BeginAccountDeletionResult {
  deleting: boolean;
  alreadyDeleted: boolean;
  attemptId: string;
  expiresAt?: number;
}
export interface CancelAccountDeletionResult {
  cancelled: boolean;
  barrierActive?: boolean;
}
export interface FinishAccountDeletionResult {
  deleted: boolean;
  cleanupPending?: boolean;
}
export interface RecordInterestResult {
  recorded: boolean;
}
export type PaddleOverageResult =
  { applied: true; extraDrafts: number } | { idempotent: true } | { mapped: false };
export type PaddleOverageReversalResult =
  | { revoked: true; extraDrafts: number }
  | { restored: true; extraDrafts: number }
  | { pending: true }
  | { idempotent: true }
  | { ignored: "not_overage_reversal" }
  | { mapped: false };
export type PaddleSubscriptionResult =
  | { applied: true }
  | { idempotent: true }
  | { stale: true }
  | { ignored: "unknown_price" }
  | { mapped: false };
export type PaddleSubscriptionCheckoutReservationResult =
  | { reserved: true; reservationId: string }
  | {
      pending: true;
      reservationId?: string;
      createdAt?: number;
      expiresAt?: number;
      transactionId?: string;
      checkoutUrl?: string | null;
      priceId?: string;
      quantity?: number;
      customerId?: string;
    };
export type PaddleOverageCheckoutReservationResult = PaddleSubscriptionCheckoutReservationResult;
export type PaddleSubscriptionCheckoutPeekResult =
  { pending: false } | Extract<PaddleSubscriptionCheckoutReservationResult, { pending: true }>;
export type PaddleOverageCheckoutPeekResult = PaddleSubscriptionCheckoutPeekResult;
export type PaddleSubscriptionCheckoutRecordResult =
  { recorded: true } | { stale: true } | { unusable: true };
export type PaddleOverageCheckoutRecordResult = PaddleSubscriptionCheckoutRecordResult;
export type PaddleSubscriptionCheckoutReleaseResult = { released: true };
export type PaddleOverageCheckoutReleaseResult = PaddleSubscriptionCheckoutReleaseResult;

async function call<T>(env: Env, userId: string, op: string, body: unknown): Promise<T> {
  const id = env.ACCOUNT_QUOTA.idFromName(userId);
  const stub = env.ACCOUNT_QUOTA.get(id);
  const res = await stub.fetch(`https://account-quota.internal${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await quotaError(res, op);
  }
  return res.json<T>();
}

async function quotaError(res: Response, op: string): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new Error(`quota_${op.slice(1)}_failed`);
  }

  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const fields = error as Record<string, unknown>;
      if (typeof fields.type === "string" && typeof fields.message === "string") {
        const extra: ErrorExtra = {};
        for (const [key, value] of Object.entries(fields)) {
          if (key !== "type" && key !== "message") {
            extra[key] = value;
          }
        }
        return new ApiError(res.status, fields.type, fields.message, extra);
      }
    }
  }

  return new Error(`quota_${op.slice(1)}_failed`);
}

/** Rate-limit check + current window snapshot (records the request timestamp). */
export function quotaCheck(
  env: Env,
  userId: string,
  body: { now: number; rateLimitPerMin: number },
): Promise<CheckResult> {
  return call<CheckResult>(env, userId, "/check", body);
}

/** Atomically admit a draft against the weekly quota and reserve one draft slot. */
export function quotaReserve(
  env: Env,
  userId: string,
  body: { now: number; reservationId: string; estimatedTokens: number; limits: ResolvedLimits },
): Promise<ReserveResult> {
  return call<ReserveResult>(env, userId, "/reserve", body);
}

/** Settle token usage after a successful reserved draft; returns the updated window. */
export function quotaSettle(env: Env, userId: string, body: SettleBody): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/settle", body);
}

/** Persist a settlement for Durable Object alarm replay after immediate retries fail. */
export function quotaDeferSettlement(
  env: Env,
  userId: string,
  body: SettleBody,
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/defer-settlement", body);
}

/** Persist a reservation release for alarm replay after deletion temporarily blocks it. */
export function quotaDeferRelease(
  env: Env,
  userId: string,
  body: {
    now: number;
    reservationId: string;
    reservationWindowStart: number;
    estimatedTokens: number;
  },
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/defer-release", body);
}

/** Roll back a reserved draft slot after an upstream failure. */
export function quotaRelease(
  env: Env,
  userId: string,
  body: {
    now: number;
    reservationId?: string;
    reservationWindowStart: number;
    estimatedTokens: number;
  },
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/release", body);
}

/** Read (and roll) the window without rate-limiting or incrementing — for /v1/me. */
export function quotaPeek(env: Env, userId: string, body: { now: number }): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/peek", body);
}

/** Serialize and record an interest signal through the user's Durable Object. */
export function quotaRecordInterest(
  env: Env,
  userId: string,
  body: { topic: InterestTopic },
): Promise<RecordInterestResult> {
  return call<RecordInterestResult>(env, userId, "/interest", body);
}

/** Serialize and record a Paddle overage entitlement through the user's Durable Object. */
export function quotaRecordPaddleOverage(
  env: Env,
  userId: string,
  body: {
    now: number;
    eventWindowStart?: number;
    eventId: string;
    transactionId: string;
    customerId: string | null;
    extraDrafts: number;
    credits: OverageCreditItem[];
  },
): Promise<PaddleOverageResult> {
  return call<PaddleOverageResult>(env, userId, "/paddle-overage", body);
}

/** Serialize and revoke/restore a Paddle overage entitlement adjustment. */
export function quotaRecordPaddleOverageReversal(
  env: Env,
  userId: string,
  body: {
    now: number;
    eventId: string;
    adjustmentId: string;
    transactionId: string;
    customerId: string | null;
    action: OverageAdjustmentAction;
    adjustmentType: string | null;
    hasAdjustmentItems: boolean;
    items: OverageAdjustmentItem[];
  },
): Promise<PaddleOverageReversalResult> {
  return call<PaddleOverageReversalResult>(env, userId, "/paddle-overage-reversal", body);
}

/** Serialize and record a Paddle subscription entitlement through the user's Durable Object. */
export function quotaRecordPaddleSubscription(
  env: Env,
  userId: string,
  body: { now: number; event: PaddleEvent },
): Promise<PaddleSubscriptionResult> {
  return call<PaddleSubscriptionResult>(env, userId, "/paddle-subscription", body);
}

/** Reserve a per-account subscription checkout slot before creating it in Paddle. */
export function quotaReservePaddleSubscriptionCheckout(
  env: Env,
  userId: string,
  body: { now: number; reservationId: string; priceId: string; quantity: number },
): Promise<PaddleSubscriptionCheckoutReservationResult> {
  return call<PaddleSubscriptionCheckoutReservationResult>(
    env,
    userId,
    "/paddle-subscription-checkout-reserve",
    body,
  );
}

/** Attach the created Paddle transaction to a pending subscription checkout slot. */
export function quotaRecordPaddleSubscriptionCheckout(
  env: Env,
  userId: string,
  body: {
    reservationId: string;
    transactionId: string;
    checkoutUrl: string | null;
    priceId: string;
    quantity: number;
  },
): Promise<PaddleSubscriptionCheckoutRecordResult> {
  return call<PaddleSubscriptionCheckoutRecordResult>(
    env,
    userId,
    "/paddle-subscription-checkout-record",
    body,
  );
}

/** Read the current per-account subscription checkout slot without creating one. */
export function quotaPeekPaddleSubscriptionCheckout(
  env: Env,
  userId: string,
  body: { now: number },
): Promise<PaddleSubscriptionCheckoutPeekResult> {
  return call<PaddleSubscriptionCheckoutPeekResult>(
    env,
    userId,
    "/paddle-subscription-checkout-peek",
    body,
  );
}

/** Release a pending subscription checkout slot after Paddle transaction creation fails. */
export function quotaReleasePaddleSubscriptionCheckout(
  env: Env,
  userId: string,
  reservationId: string,
): Promise<PaddleSubscriptionCheckoutReleaseResult> {
  return call<PaddleSubscriptionCheckoutReleaseResult>(
    env,
    userId,
    "/paddle-subscription-checkout-release",
    { reservationId },
  );
}

/** Reserve a per-account overage checkout slot before creating it in Paddle. */
export function quotaReservePaddleOverageCheckout(
  env: Env,
  userId: string,
  body: {
    now: number;
    reservationId: string;
    priceId: string;
    quantity: number;
    customerId: string;
  },
): Promise<PaddleOverageCheckoutReservationResult> {
  return call<PaddleOverageCheckoutReservationResult>(
    env,
    userId,
    "/paddle-overage-checkout-reserve",
    body,
  );
}

/** Attach the created Paddle transaction to a pending overage checkout slot. */
export function quotaRecordPaddleOverageCheckout(
  env: Env,
  userId: string,
  body: {
    reservationId: string;
    transactionId: string;
    checkoutUrl: string | null;
    priceId: string;
    quantity: number;
    customerId: string;
  },
): Promise<PaddleOverageCheckoutRecordResult> {
  return call<PaddleOverageCheckoutRecordResult>(
    env,
    userId,
    "/paddle-overage-checkout-record",
    body,
  );
}

/** Read the current per-account overage checkout slot without creating one. */
export function quotaPeekPaddleOverageCheckout(
  env: Env,
  userId: string,
  body: { now: number },
): Promise<PaddleOverageCheckoutPeekResult> {
  return call<PaddleOverageCheckoutPeekResult>(env, userId, "/paddle-overage-checkout-peek", body);
}

/** Release a pending overage checkout slot after the transaction is canceled or completed. */
export function quotaReleasePaddleOverageCheckout(
  env: Env,
  userId: string,
  reservationId: string,
): Promise<PaddleOverageCheckoutReleaseResult> {
  return call<PaddleOverageCheckoutReleaseResult>(env, userId, "/paddle-overage-checkout-release", {
    reservationId,
  });
}

/** Set a deletion barrier before attempting Clerk deletion. Does not wipe counters. */
export function quotaBeginAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
): Promise<BeginAccountDeletionResult> {
  return call<BeginAccountDeletionResult>(env, userId, "/begin-delete", {
    now: Date.now(),
    attemptId,
  });
}

/** Remove an in-progress deletion barrier when Clerk deletion fails. */
export function quotaCancelAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
): Promise<CancelAccountDeletionResult> {
  return call<CancelAccountDeletionResult>(env, userId, "/cancel-delete", {
    now: Date.now(),
    attemptId,
  });
}

/** Wipe account quota data after Clerk deletion succeeds and keep a stale-token tombstone. */
export function quotaFinishAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
): Promise<FinishAccountDeletionResult> {
  return call<FinishAccountDeletionResult>(env, userId, "/finish-delete", {
    now: Date.now(),
    attemptId,
  });
}

/**
 * Compatibility alias for final account deletion. New callers should use the
 * begin/delete/cancel-or-finish flow above so Clerk failures do not wipe quotas.
 */
export function quotaWipe(env: Env, userId: string): Promise<{ wiped: boolean; deleted: boolean }> {
  return call<{ wiped: boolean; deleted: boolean }>(env, userId, "/wipe", {});
}
