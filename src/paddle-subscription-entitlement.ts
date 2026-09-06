import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { type Env } from "./config";
import { ApiError } from "./errors";
import {
  paddleCheckoutBindingMatchesEvent,
  paddleCustomerMatchesAccount,
  storedPaddleSubscriptionId,
  supersededPaddleSubscriptionIds,
} from "./paddle-account";
import { fetchPaddleSubscriptionSnapshot } from "./paddle-api";
import {
  buildSubscriptionRecord,
  customerIdFromEvent,
  isSubscriptionEvent,
  planFromEvent,
  resolvePlanDraftLimit,
  subscriptionIdFromEvent,
  type PaddleEvent,
} from "./paddle";

const SUPERSEDED_SUBSCRIPTION_ID_LIMIT = 20;

export interface PaddleSubscriptionBody {
  now: number;
  event: PaddleEvent;
}

export type PaddleSubscriptionResult =
  | { applied: true }
  | { idempotent: true }
  | { stale: true }
  | { ignored: "unknown_price" }
  | { mapped: false };

export function parsePaddleSubscriptionBody(body: unknown): PaddleSubscriptionBody {
  const record = asRecord(body);
  const eventRecord = asRecord(record?.event);
  if (!record || !eventRecord) {
    throw new ApiError(400, "invalid_request", "Request body must include a subscription event.");
  }

  const eventId = eventRecord.eventId;
  const eventType = eventRecord.eventType;
  const data = asRecord(eventRecord.data);
  if (
    typeof eventId !== "string" ||
    eventId === "" ||
    typeof eventType !== "string" ||
    eventType === "" ||
    !isSubscriptionEvent(eventType) ||
    !data
  ) {
    throw new ApiError(400, "invalid_request", "Invalid subscription event.");
  }

  const occurredAt = eventRecord.occurredAt;
  if (occurredAt !== null && occurredAt !== undefined && typeof occurredAt !== "string") {
    throw new ApiError(400, "invalid_request", "Invalid subscription event timestamp.");
  }

  return {
    now: positiveInt(record.now) ?? Date.now(),
    event: {
      eventId,
      eventType,
      occurredAt: occurredAt ?? null,
      data,
    },
  };
}

export async function recordPaddleSubscriptionInClerk(
  userId: string,
  body: PaddleSubscriptionBody,
  env: Env,
): Promise<PaddleSubscriptionResult> {
  const mapped = planFromEvent(body.event);
  if (!mapped) {
    return { ignored: "unknown_price" };
  }

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }

  const meta = user.privateMetadata ?? {};
  if (!(await subscriptionEventMatchesAccount(userId, user, meta, body.event, env))) {
    return { mapped: false };
  }

  const existingSub = asRecord(meta.subscription);
  if (existingSub && existingSub.lastEventId === body.event.eventId) {
    return { idempotent: true };
  }

  const existingSubscriptionId = storedPaddleSubscriptionId(existingSub);
  const supersededSubscriptionIds = supersededPaddleSubscriptionIds(existingSub);
  const incomingSubscriptionId = subscriptionIdFromEvent(body.event);
  if (incomingSubscriptionId && supersededSubscriptionIds.includes(incomingSubscriptionId)) {
    return { stale: true };
  }
  const isDifferentSubscription =
    !!existingSubscriptionId &&
    (!incomingSubscriptionId || existingSubscriptionId !== incomingSubscriptionId);
  if (
    isDifferentSubscription &&
    !(await isCurrentSubscriptionReplacement(body.event, userId, env))
  ) {
    return { stale: true };
  }

  const incomingOrder = subscriptionEventOrderKey(body.event.occurredAt, body.now);
  if (!isDifferentSubscription && existingSub) {
    const existingOrder = storedSubscriptionOrderKey(existingSub);
    if (existingOrder !== null && incomingOrder !== null && existingOrder > incomingOrder) {
      return { stale: true };
    }
  }

  const record = {
    ...buildSubscriptionRecord(body.event, mapped.plan, mapped.priceId, body.now),
    ...supersededSubscriptionHistory(
      supersededSubscriptionIds,
      isDifferentSubscription ? existingSubscriptionId : null,
    ),
  };
  const quota = quotaForSubscriptionStatus(
    asRecord(meta.quota) ?? {},
    record.status,
    mapped.plan,
    env,
  );

  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: { subscription: record, quota },
    });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the subscription.");
  }

  return { applied: true };
}

async function subscriptionEventMatchesAccount(
  userId: string,
  user: unknown,
  meta: Record<string, unknown>,
  event: PaddleEvent,
  env: Env,
): Promise<boolean> {
  if (paddleCustomerMatchesAccount(user, meta, customerIdFromEvent(event), env)) return true;
  return paddleCheckoutBindingMatchesEvent(event, userId, env);
}

async function isCurrentSubscriptionReplacement(
  event: PaddleEvent,
  userId: string,
  env: Env,
): Promise<boolean> {
  if (!(await paddleCheckoutBindingMatchesEvent(event, userId, env))) return false;

  const incomingSubscriptionId = subscriptionIdFromEvent(event);
  if (!incomingSubscriptionId) return false;

  const snapshot = await fetchPaddleSubscriptionSnapshot(env, incomingSubscriptionId);
  if (!snapshot) return false;

  const incomingCustomerId = customerIdFromEvent(event);
  if (incomingCustomerId && snapshot.customerId !== incomingCustomerId) return false;
  return snapshot.status !== null && snapshot.status === paddleSubscriptionStatusFromEvent(event);
}

function paddleSubscriptionStatusFromEvent(event: PaddleEvent): string | null {
  const dataStatus = typeof event.data.status === "string" ? event.data.status : null;
  if (isPaddleSubscriptionStatus(dataStatus)) return dataStatus;

  switch (event.eventType) {
    case "subscription.canceled":
      return "canceled";
    case "subscription.paused":
      return "paused";
    case "subscription.past_due":
      return "past_due";
    case "subscription.activated":
    case "subscription.resumed":
      return "active";
    default:
      return null;
  }
}

function isPaddleSubscriptionStatus(value: unknown): value is string {
  return (
    value === "active" ||
    value === "trialing" ||
    value === "past_due" ||
    value === "paused" ||
    value === "canceled"
  );
}

function quotaForSubscriptionStatus(
  existingQuota: Record<string, unknown>,
  status: string,
  plan: "starter" | "pro" | "unlimited",
  env: Env,
): Record<string, unknown> {
  const quota = { ...existingQuota };
  if (status === "active" || status === "trialing" || status === "past_due") {
    quota.weeklyDraftLimit = resolvePlanDraftLimit(env, plan);
  } else {
    delete quota.weeklyDraftLimit;
  }
  return quota;
}

function supersededSubscriptionHistory(
  existingIds: string[],
  replacedSubscriptionId: string | null,
): { supersededPaddleSubscriptionIds?: string[] } {
  const ids = replacedSubscriptionId ? [...existingIds, replacedSubscriptionId] : existingIds;
  const unique = [...new Set(ids.filter((id) => id !== ""))].slice(
    -SUPERSEDED_SUBSCRIPTION_ID_LIMIT,
  );
  return unique.length > 0 ? { supersededPaddleSubscriptionIds: unique } : {};
}

function storedSubscriptionOrderKey(existingSub: Record<string, unknown>): bigint | null {
  const exact =
    typeof existingSub.paddleOccurredAt === "string" ? existingSub.paddleOccurredAt : null;
  const fallback = typeof existingSub.updatedAt === "string" ? existingSub.updatedAt : null;
  return subscriptionTimestampOrderKey(exact) ?? subscriptionTimestampOrderKey(fallback);
}

function subscriptionEventOrderKey(occurredAt: string | null, now: number): bigint | null {
  return subscriptionTimestampOrderKey(occurredAt ?? new Date(now).toISOString());
}

function subscriptionTimestampOrderKey(value: string | null): bigint | null {
  if (!value) return null;

  const precise = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!precise) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : BigInt(ms) * 1_000_000n;
  }

  const secondsMs = Date.parse(`${precise[1]}.000${precise[3]}`);
  if (Number.isNaN(secondsMs)) return null;
  const nanos = BigInt((precise[2] ?? "").slice(0, 9).padEnd(9, "0"));
  return BigInt(Math.floor(secondsMs / 1000)) * 1_000_000_000n + nanos;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
