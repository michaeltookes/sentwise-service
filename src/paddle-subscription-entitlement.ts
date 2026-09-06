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
  statusFromEvent,
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

  const incomingUpdatedAt = body.event.occurredAt ? Date.parse(body.event.occurredAt) : body.now;
  if (!isDifferentSubscription && existingSub && typeof existingSub.updatedAt === "string") {
    const existingUpdatedAt = Date.parse(existingSub.updatedAt);
    if (
      !Number.isNaN(existingUpdatedAt) &&
      !Number.isNaN(incomingUpdatedAt) &&
      existingUpdatedAt > incomingUpdatedAt
    ) {
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
  const quota = {
    ...(asRecord(meta.quota) ?? {}),
    weeklyDraftLimit: resolvePlanDraftLimit(env, mapped.plan),
  };

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
  if (!isPromotableSubscriptionReplacement(event)) return false;
  if (!(await paddleCheckoutBindingMatchesEvent(event, userId, env))) return false;

  const incomingSubscriptionId = subscriptionIdFromEvent(event);
  if (!incomingSubscriptionId) return false;

  const snapshot = await fetchPaddleSubscriptionSnapshot(env, incomingSubscriptionId);
  if (!snapshot) return false;

  const incomingCustomerId = customerIdFromEvent(event);
  if (incomingCustomerId && snapshot.customerId !== incomingCustomerId) return false;
  return snapshot.status === "active" || snapshot.status === "trialing";
}

function isPromotableSubscriptionReplacement(event: PaddleEvent): boolean {
  if (event.eventType !== "subscription.created" && event.eventType !== "subscription.activated") {
    return false;
  }
  const status = statusFromEvent(event);
  return status === "active" || status === "trialing";
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

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
