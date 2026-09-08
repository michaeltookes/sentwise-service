import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { PRICE_TO_PLAN, type Env, type PaidPlan } from "./config";
import { ApiError } from "./errors";
import { resolvePlanDraftLimit } from "./paddle";
import { storedPaddleSubscriptionId } from "./paddle-account";
import { changePaddleSubscription, type PaddleSubscriptionChangeResult } from "./paddle-api";

// In-app plan change (item 90). Upgrades/downgrades an active Paddle subscription
// to a different paid tier with proration, then writes the new tier's weekly draft
// limit into the account so 56b enforcement uses it immediately. The
// `subscription.updated` webhook fires in parallel and reconciles authoritatively;
// the two paths are kept consistent + idempotent (see recordChangedPlanEntitlement).
//
// PRORATION: both upgrades and downgrades use `prorated_immediately`. A single
// immediate mode keeps this endpoint's optimistic quota write and the webhook's
// reconciliation in agreement — the new tier applies now, the webhook's
// subscription.updated carries the same price/plan, and there is no scheduled
// "takes effect next period" state where the stored quota would disagree with the
// tier the customer is actually paying for. (Documented in README.)
const PLAN_CHANGE_PRORATION_BILLING_MODE = "prorated_immediately";

// PRIVACY: handles only plan/price enums, ids, and counters — never prompt or
// draft content. No console.* logging anywhere (enforced by
// scripts/check-no-body-logging.sh).

export async function handlePaddleChangePlan(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const priceId = await parseChangePlanRequest(request);

  const targetPlan = PRICE_TO_PLAN[priceId];
  if (!targetPlan) {
    throw new ApiError(400, "invalid_request", "Unsupported Paddle price id.");
  }
  if (!env.PADDLE_API_KEY) {
    throw new ApiError(503, "checkout_unavailable", "Plan changes are not configured.");
  }

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const account = await loadChangePlanAccount(clerk, userId);

  const subscriptionId = storedPaddleSubscriptionId(account.subscription);
  if (!subscriptionId) {
    throw new ApiError(
      404,
      "billing_subscription_not_found",
      "No active Paddle subscription was found.",
    );
  }

  // Same price = same plan (PRICE_TO_PLAN is a bijection). No-op: reject rather
  // than round-trip Paddle. Reported as 400 invalid_request to match the shared
  // app contract (item 90).
  const currentPriceId = storedSubscriptionPriceId(account.subscription);
  if (currentPriceId && currentPriceId === priceId) {
    throw new ApiError(400, "invalid_request", "You're already on that plan.");
  }

  const result = await changePaddleSubscription(env, subscriptionId, {
    priceId,
    prorationBillingMode: PLAN_CHANGE_PRORATION_BILLING_MODE,
  });

  await recordChangedPlanEntitlement(clerk, userId, account, targetPlan, priceId, result, env);

  const res = Response.json({
    ok: true,
    plan: targetPlan,
    status: result.status ?? storedSubscriptionStatus(account.subscription) ?? "active",
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

async function parseChangePlanRequest(request: Request): Promise<string> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
  }
  const body = asRecord(raw);
  const priceId = body?.priceId;
  if (!body || typeof priceId !== "string" || priceId === "") {
    throw new ApiError(400, "invalid_request", "Missing Paddle price id.");
  }
  return priceId;
}

async function loadChangePlanAccount(
  clerk: ReturnType<typeof createClerkClient>,
  userId: string,
): Promise<{ subscription: unknown; quota: unknown }> {
  try {
    const user = await clerk.users.getUser(userId);
    const meta = asRecord(user.privateMetadata) ?? {};
    return { subscription: meta.subscription, quota: meta.quota };
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
}

/**
 * Optimistically bump the stored subscription record's plan/priceId and the
 * account's weekly draft limit to the new tier, preserving every reconciliation +
 * idempotency field (`lastEventId`, `paddleOccurredAt`, `paddleSubscriptionId`,
 * `paddleCustomerId`, superseded ids). The subscription.updated webhook that
 * Paddle fires for this change carries a newer `occurredAt` than what we leave in
 * place, so it always wins the order check and reconciles — never treating our
 * write as stale, never double-applying. Status is left untouched (a plan change
 * does not change subscription status; the webhook owns status transitions) so a
 * raw Paddle status outside our enum can't poison the stored record.
 */
async function recordChangedPlanEntitlement(
  clerk: ReturnType<typeof createClerkClient>,
  userId: string,
  account: { subscription: unknown; quota: unknown },
  plan: PaidPlan,
  priceId: string,
  _result: PaddleSubscriptionChangeResult,
  env: Env,
): Promise<void> {
  const existingSub = asRecord(account.subscription) ?? {};
  const existingQuota = asRecord(account.quota) ?? {};

  const subscription = {
    ...existingSub,
    plan,
    priceId,
    updatedAt: new Date().toISOString(),
  };
  const quota = {
    ...existingQuota,
    weeklyDraftLimit: resolvePlanDraftLimit(env, plan),
  };

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
}

function storedSubscriptionPriceId(rawSubscription: unknown): string | null {
  const priceId = asRecord(rawSubscription)?.priceId;
  return typeof priceId === "string" && priceId !== "" ? priceId : null;
}

function storedSubscriptionStatus(rawSubscription: unknown): string | null {
  const status = asRecord(rawSubscription)?.status;
  return typeof status === "string" && status !== "" ? status : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
