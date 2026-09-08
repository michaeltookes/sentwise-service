import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { PRICE_TO_PLAN, type Env, type PaidPlan } from "./config";
import { ApiError } from "./errors";
import { resolvePlanDraftLimit } from "./paddle";
import { storedPaddleSubscriptionId } from "./paddle-account";

export interface PaddlePlanChangeEntitlementBody {
  subscriptionId: string;
  previousPriceId: string | null;
  previousOrderTimestamp: string | null;
  plan: PaidPlan;
  priceId: string;
}

export type PaddlePlanChangeEntitlementResult =
  { applied: true; status: string | null } | { stale: true; status: string | null };

export function parsePaddlePlanChangeEntitlementBody(
  body: unknown,
): PaddlePlanChangeEntitlementBody {
  const record = asRecord(body);
  const subscriptionId = record?.subscriptionId;
  const previousPriceId = record?.previousPriceId;
  const previousOrderTimestamp = record?.previousOrderTimestamp;
  const plan = record?.plan;
  const priceId = record?.priceId;
  if (
    !record ||
    typeof subscriptionId !== "string" ||
    subscriptionId === "" ||
    !isNullablePriceId(previousPriceId) ||
    !isNullableNonEmptyString(previousOrderTimestamp) ||
    !isPaidPlan(plan) ||
    typeof priceId !== "string" ||
    priceId === "" ||
    PRICE_TO_PLAN[priceId] !== plan
  ) {
    throw new ApiError(400, "invalid_request", "Invalid plan-change entitlement.");
  }
  return { subscriptionId, previousPriceId, previousOrderTimestamp, plan, priceId };
}

/**
 * Optimistically bump the stored subscription record's plan/priceId and the
 * account's weekly draft limit to the new tier. This function is called from the
 * account Durable Object write queue and reads Clerk metadata inside that queue,
 * so webhook updates that finish during the Paddle network call are preserved.
 */
export async function recordPaddlePlanChangeInClerk(
  userId: string,
  body: PaddlePlanChangeEntitlementBody,
  env: Env,
): Promise<PaddlePlanChangeEntitlementResult> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "Your account could not be found.");
    }
    throw new ApiError(
      502,
      "account_lookup_failed",
      "Could not load your account. Please try again.",
    );
  }

  const meta = asRecord(user.privateMetadata) ?? {};
  const existingSub = asRecord(meta.subscription) ?? {};
  const status = storedSubscriptionStatus(existingSub);
  if (storedPaddleSubscriptionId(existingSub) !== body.subscriptionId) {
    return { stale: true, status };
  }
  const latestPriceId = storedSubscriptionPriceId(existingSub);
  const latestOrderTimestamp = storedSubscriptionOrderTimestamp(existingSub);
  const isAlreadyTarget = latestPriceId === body.priceId;
  const isStillObservedVersion =
    latestPriceId === body.previousPriceId && latestOrderTimestamp === body.previousOrderTimestamp;
  if (!isAlreadyTarget && !isStillObservedVersion) {
    return { stale: true, status };
  }

  const subscription = {
    ...existingSub,
    plan: body.plan,
    priceId: body.priceId,
  };
  const quota = quotaForLatestSubscriptionStatus(
    asRecord(meta.quota) ?? {},
    status,
    body.plan,
    env,
  );

  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: { subscription, quota },
    });
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "Your account could not be found.");
    }
    throw new ApiError(502, "entitlement_write_failed", "Could not update your plan.");
  }

  return { applied: true, status };
}

function quotaForLatestSubscriptionStatus(
  existingQuota: Record<string, unknown>,
  status: string | null,
  plan: PaidPlan,
  env: Env,
): Record<string, unknown> {
  const quota = { ...existingQuota };
  if (status === "active" || status === "trialing" || status === "past_due") {
    quota.weeklyDraftLimit = resolvePlanDraftLimit(env, plan);
  } else {
    quota.weeklyDraftLimit = null;
  }
  return quota;
}

function storedSubscriptionStatus(rawSubscription: Record<string, unknown>): string | null {
  const status = rawSubscription.status;
  return typeof status === "string" && status !== "" ? status : null;
}

function storedSubscriptionPriceId(rawSubscription: Record<string, unknown>): string | null {
  const priceId = rawSubscription.priceId;
  return typeof priceId === "string" && priceId !== "" ? priceId : null;
}

function storedSubscriptionOrderTimestamp(rawSubscription: Record<string, unknown>): string | null {
  const paddleOccurredAt = rawSubscription.paddleOccurredAt;
  if (typeof paddleOccurredAt === "string" && paddleOccurredAt !== "") return paddleOccurredAt;
  const updatedAt = rawSubscription.updatedAt;
  return typeof updatedAt === "string" && updatedAt !== "" ? updatedAt : null;
}

function isNullablePriceId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value !== "");
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value !== "");
}

function isPaidPlan(value: unknown): value is PaidPlan {
  return value === "starter" || value === "pro" || value === "unlimited";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
