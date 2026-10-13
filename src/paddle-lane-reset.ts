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
import { cancelPaddleSubscriptionImmediately } from "./paddle-api";
import {
  isQaAccountEmail,
  lockedPaddleLane,
  paddleEnvForStoredLane,
  storedPaddleLane,
  type PaddleLane,
} from "./paddle-env";
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
    if (hasLivePaddleSubscriptionInForce(meta.subscription)) {
      throw new ApiError(
        409,
        "billing_live_subscription_active",
        "This account has a live Paddle subscription in force. Cancel it in Paddle first.",
      );
    }

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

    const result = await quotaResetPaddleLane(env, userId, {
      lane: previousLane ?? "sandbox",
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

export async function clearPaddleLaneInClerk(userId: string, env: Env): Promise<void> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: {
        subscription: null,
        paddleLane: null,
        quota: PADDLE_QUOTA_FIELDS_CLEARED,
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
}

export function parsePaddleLaneResetBody(body: unknown): PaddleLaneResetBody {
  const lane =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>).lane : null;
  if (lane !== "sandbox" && lane !== "production") {
    throw new ApiError(400, "invalid_request", "A lane is required.");
  }
  return { lane };
}
