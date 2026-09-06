import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { type Env } from "./config";
import { ApiError } from "./errors";
import { paddleCustomerMatchesAccount, storedPaddleSubscriptionId } from "./paddle-account";
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
  if (!(await paddleCustomerMatchesAccount(user, meta, customerIdFromEvent(body.event), env))) {
    return { mapped: false };
  }

  const existingSub = asRecord(meta.subscription);
  if (existingSub && existingSub.lastEventId === body.event.eventId) {
    return { idempotent: true };
  }

  const existingSubscriptionId = storedPaddleSubscriptionId(existingSub);
  const incomingSubscriptionId = subscriptionIdFromEvent(body.event);
  const isDifferentSubscription =
    !!existingSubscriptionId &&
    (!incomingSubscriptionId || existingSubscriptionId !== incomingSubscriptionId);
  if (isDifferentSubscription && !isPromotableSubscriptionReplacement(body.event)) {
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

  const record = buildSubscriptionRecord(body.event, mapped.plan, mapped.priceId, body.now);
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

function isPromotableSubscriptionReplacement(event: PaddleEvent): boolean {
  if (event.eventType !== "subscription.created" && event.eventType !== "subscription.activated") {
    return false;
  }
  const status = statusFromEvent(event);
  return status === "active" || status === "trialing";
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
