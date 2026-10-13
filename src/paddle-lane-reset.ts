// 123 — QA-only admin lane reset. POST /admin/paddle-lane-reset { email|userId }
//
// Lane transitions are refused, not reconciled: once an account holds billing
// state in one Paddle environment it is locked there (src/paddle-env.ts). This
// route is the ONLY way a QA (@prowlqa.dev) account leaves its lane:
//   1. cancels its SANDBOX subscription at Paddle sandbox (never touches live
//      Paddle; a live subscription still in force refuses the reset with 409),
//   2. in the account's AccountQuota DO, serialized with every other billing
//      write: releases its checkout reservations (cancelling their sandbox
//      transactions best-effort), retires the overage ledger while keeping
//      environment-scoped replay tombstones, and clears the Clerk subscription,
//      Paddle-written quota fields, and the lane lock.
// Same ADMIN_TOKEN gate as /admin/comp (404 when unset, 401 otherwise).
//
// PRIVACY: handles only account ids, an email address, Paddle ids, and counts.

import { createClerkClient } from "@clerk/backend";
import { authorizeAdmin } from "./admin";
import { jsonBody, parseTarget, resolveTargetUser } from "./admin-comp";
import { isClerkNotFoundError, primaryEmail } from "./auth";
import { invalidateClerkUser } from "./clerk-user-cache";
import type { Env } from "./config";
import { ApiError, jsonError } from "./errors";
import { hasLivePaddleSubscriptionInForce, storedPaddleSubscriptionId } from "./paddle-account";
import {
  cancelPaddleSubscriptionImmediately,
  cancelPaddleTransaction,
  fetchPaddleSubscriptionSnapshot,
  fetchPaddleTransactionSnapshot,
  findPaddleCheckoutTransactionByReservationId,
} from "./paddle-api";
import {
  isQaAccountEmail,
  lockedPaddleLane,
  PADDLE_LANE_GENERATION_METADATA_KEY,
  PADDLE_LANE_METADATA_KEY,
  PADDLE_RETIRED_SUBSCRIPTIONS_METADATA_KEY,
  paddleEnvForStoredLane,
  paddleLaneGeneration,
  retiredPaddleSubscriptionIds,
  storedPaddleLane,
  type PaddleLane,
} from "./paddle-env";

const RETIRED_SUBSCRIPTION_LIMIT = 100;
import { quotaResetPaddleLane } from "./quota-client";

export async function handleAdminPaddleLaneReset(request: Request, env: Env): Promise<Response> {
  const denied = await authorizeAdmin(request, env);
  if (denied) return denied;
  if (request.method !== "POST") {
    return jsonError(405, "method_not_allowed", "Method not allowed.");
  }
  try {
    const body = await jsonBody(request);
    const target = parseTarget({ userId: body.userId, email: body.email });
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    const { userId, user } = await resolveTargetUser(clerk, target);
    const email = primaryEmail(user);
    if (!isQaAccountEmail(email)) {
      throw new ApiError(
        403,
        "paddle_lane_reset_forbidden",
        "Only @prowlqa.dev QA accounts can have their billing lane reset.",
      );
    }
    const meta = (user.privateMetadata ?? {}) as Record<string, unknown>;
    assertNoLiveSubscriptionInForce(meta);
    await assertLegacyLiveRecordIsClosed(meta, env);

    const previousLane = lockedPaddleLane(meta);
    let canceledSubscriptionId: string | null = null;
    const subscriptionId = storedPaddleSubscriptionId(meta.subscription);
    if (subscriptionId && storedPaddleLane(meta.subscription) === "sandbox") {
      await cancelPaddleSubscriptionImmediately(
        paddleEnvForStoredLane(env, "sandbox"),
        subscriptionId,
      );
      canceledSubscriptionId = subscriptionId;
    }

    // The DO re-validates all of this inside its serialized operation and
    // aborts with 409 if the account changed in between.
    const result = await quotaResetPaddleLane(env, userId, {
      lane: previousLane ?? "sandbox",
      expectedSubscriptionId: subscriptionId,
    });
    invalidateClerkUser(userId);
    return Response.json({
      userId,
      email,
      previousLane,
      canceledSubscriptionId,
      ...result,
    });
  } catch (err) {
    if (err instanceof ApiError) return err.toResponse();
    return jsonError(500, "internal_error", "Something went wrong. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// The Clerk half, run inside the AccountQuota DO's serialized metadata queue.
// ---------------------------------------------------------------------------

/** Clerk deep-merges privateMetadata: null removes a key. */
const PADDLE_QUOTA_FIELDS_CLEARED = {
  monthlyDraftLimit: null,
  extraDrafts: null,
  extraDraftsWindowStart: null,
  lastOverageEventId: null,
  processedOverageEventIds: null,
  processedOverageAdjustmentIds: null,
  overageCreditTransactions: null,
  overageCredits: null,
  pendingOverageReversals: null,
};

/** Transaction ids Clerk already credited, kept as replay tombstones. */
export function clerkCreditedTransactionIds(meta: Record<string, unknown>): string[] {
  const quota = meta.quota;
  if (typeof quota !== "object" || quota === null) return [];
  const list = (quota as Record<string, unknown>).overageCreditTransactions;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) =>
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>).transactionId
        : undefined,
    )
    .filter((id): id is string => typeof id === "string" && id !== "");
}

export async function loadPaddleResetMetadata(
  userId: string,
  env: Env,
): Promise<Record<string, unknown>> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    const user = await clerk.users.getUser(userId);
    return user.privateMetadata ?? {};
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "No account matches that userId.");
    }
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }
}

/** No live subscription in force (paused included) — the reset never touches live Paddle. */
export function assertNoLiveSubscriptionInForce(meta: Record<string, unknown>): void {
  if (hasLivePaddleSubscriptionInForce(meta.subscription)) {
    throw new ApiError(
      409,
      "billing_live_subscription_active",
      "This account has a live Paddle subscription in force. Cancel it in Paddle first.",
    );
  }
}

/**
 * Records written before Paddle's raw status was kept stored a PAUSED live
 * subscription as status "canceled" with no paddleStatus. For such a record,
 * ask Paddle before allowing the reset; fail closed if Paddle can't say.
 */
async function assertLegacyLiveRecordIsClosed(
  meta: Record<string, unknown>,
  env: Env,
): Promise<void> {
  const sub = meta.subscription;
  const subscriptionId = storedPaddleSubscriptionId(sub);
  if (!subscriptionId || storedPaddleLane(sub) !== "production") return;
  const record = sub as Record<string, unknown>;
  if (typeof record.paddleStatus === "string" && record.paddleStatus !== "") return;
  let status: string | null;
  try {
    const snapshot = await fetchPaddleSubscriptionSnapshot(
      paddleEnvForStoredLane(env, "production"),
      subscriptionId,
    );
    status = snapshot?.status ?? null;
  } catch {
    status = null;
  }
  if (status === null) {
    throw new ApiError(
      409,
      "billing_live_status_unknown",
      "Could not confirm the live Paddle subscription is closed. Try again later.",
    );
  }
  if (["active", "trialing", "past_due", "paused"].includes(status)) {
    throw new ApiError(
      409,
      "billing_live_subscription_active",
      "This account has a live Paddle subscription in force. Cancel it in Paddle first.",
    );
  }
}

/**
 * Clear the account's Paddle state and lane lock, bump its reset generation,
 * and retire the subscription the reset cancelled, so a delayed webhook for it
 * (or for any checkout made before this reset) can never restore the state.
 */
export async function clearPaddleLaneInClerk(
  userId: string,
  env: Env,
  meta: Record<string, unknown>,
  retiredSubscriptionId: string | null,
): Promise<void> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const retired = [
    ...new Set([
      ...retiredPaddleSubscriptionIds(meta),
      ...(retiredSubscriptionId ? [retiredSubscriptionId] : []),
    ]),
  ].slice(-RETIRED_SUBSCRIPTION_LIMIT);
  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: {
        subscription: null,
        paddleLane: null,
        quota: PADDLE_QUOTA_FIELDS_CLEARED,
        [PADDLE_LANE_GENERATION_METADATA_KEY]: paddleLaneGeneration(meta) + 1,
        [PADDLE_RETIRED_SUBSCRIPTIONS_METADATA_KEY]: retired,
      },
    });
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "No account matches that userId.");
    }
    throw new ApiError(502, "entitlement_write_failed", "Could not reset the account.");
  }
}

export interface PaddleLaneResetBody {
  lane: PaddleLane;
  expectedSubscriptionId: string | null;
}

export function parsePaddleLaneResetBody(body: unknown): PaddleLaneResetBody {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const lane = record.lane;
  if (lane !== "sandbox" && lane !== "production") {
    throw new ApiError(400, "invalid_request", "A lane is required.");
  }
  const expected = record.expectedSubscriptionId;
  return {
    lane,
    expectedSubscriptionId: typeof expected === "string" && expected !== "" ? expected : null,
  };
}

/**
 * Inside the serialized reset: the account must still be the one the admin
 * handler validated — no live subscription in force and the same subscription
 * selected for cancellation — or the reset aborts with nothing cleared.
 */
export function assertResetStillValid(
  meta: Record<string, unknown>,
  expectedSubscriptionId: string | null,
): void {
  assertNoLiveSubscriptionInForce(meta);
  if ((storedPaddleSubscriptionId(meta.subscription) ?? null) !== expectedSubscriptionId) {
    throw new ApiError(
      409,
      "billing_state_changed",
      "The account's billing changed during the reset. Nothing was cleared; try again.",
    );
  }
}

const SAFE_TERMINAL_TRANSACTION_STATUSES = new Set(["canceled", "completed", "billed", "paid"]);

/**
 * Settle one pending checkout for the reset: it may be released only once its
 * transaction is confirmed cancelled or in a safe terminal state (nothing left
 * to pay). An unknown outcome throws 502 so nothing is cleared.
 */
export async function settleReservationForReset(
  env: Env,
  reservation: {
    reservationId: string;
    createdAt: number;
    expiresAt?: number;
    transactionId?: string;
    customerId?: string;
    paddleEnvironment?: string;
  },
  now: number,
): Promise<void> {
  const laneEnv = paddleEnvForStoredLane(env, storedPaddleLane(reservation));
  let transactionId = reservation.transactionId;
  if (!transactionId) {
    if (reservation.expiresAt === undefined || reservation.expiresAt > now) {
      throw new ApiError(
        409,
        "billing_checkout_pending",
        "A checkout is being created for this account. Try the reset again shortly.",
      );
    }
    let found;
    try {
      found = await findPaddleCheckoutTransactionByReservationId(laneEnv, {
        reservationId: reservation.reservationId,
        createdAt: reservation.createdAt,
        expiresAt: reservation.expiresAt,
        customerId: reservation.customerId,
      });
    } catch {
      throw resetCancelUnknownError();
    }
    if (!found) return; // no transaction was ever created
    if (found.status && SAFE_TERMINAL_TRANSACTION_STATUSES.has(found.status)) return;
    transactionId = found.transactionId;
  }
  try {
    await cancelPaddleTransaction(laneEnv, transactionId);
    return;
  } catch {
    // fall through: find out what state the transaction is actually in
  }
  let status: string | null | undefined;
  try {
    const snapshot = await fetchPaddleTransactionSnapshot(laneEnv, transactionId);
    status = snapshot === null ? "missing" : snapshot.status;
  } catch {
    throw resetCancelUnknownError();
  }
  if (status === "missing" || (status && SAFE_TERMINAL_TRANSACTION_STATUSES.has(status))) return;
  throw resetCancelUnknownError();
}

function resetCancelUnknownError(): ApiError {
  return new ApiError(
    502,
    "transaction_cancel_failed",
    "Could not confirm a pending checkout was cancelled. Nothing was cleared; try again.",
  );
}

/** Durable Object storage key holding the account's lane lock (the CAS source of truth). */
export const PADDLE_LANE_LOCK_STORAGE_KEY = "paddle_lane_lock";

/** Mirror the lane lock into Clerk (readers: checkout, plan change, /v1/me). */
export async function writePaddleLaneLockToClerk(
  userId: string,
  env: Env,
  lane: PaddleLane,
): Promise<void> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: { [PADDLE_LANE_METADATA_KEY]: lane },
    });
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "Your account could not be found.");
    }
    throw new ApiError(502, "checkout_unavailable", "Could not start checkout.");
  }
}

export function parsePaddleLaneLockBody(body: unknown): { lane: PaddleLane } {
  const lane =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).lane : null;
  if (lane !== "sandbox" && lane !== "production") {
    throw new ApiError(400, "invalid_request", "A lane is required.");
  }
  return { lane };
}
