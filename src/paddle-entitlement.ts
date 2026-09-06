import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { type Env } from "./config";
import { ApiError } from "./errors";
import { mondayStartUtc } from "./metering";

const PROCESSED_OVERAGE_EVENT_ID_LIMIT = 100;

export interface PaddleOverageBody {
  now: number;
  eventId: string;
  extraDrafts: number;
}

export type PaddleOverageResult =
  { applied: true; extraDrafts: number } | { idempotent: true } | { mapped: false };

export function parsePaddleOverageBody(body: unknown): PaddleOverageBody {
  const record = asRecord(body);
  if (!record) {
    throw new ApiError(400, "invalid_request", "Request body must be an object.");
  }
  const eventId = record.eventId;
  if (typeof eventId !== "string" || eventId === "") {
    throw new ApiError(400, "invalid_request", "Missing overage event id.");
  }
  const now = positiveInt(record.now) ?? Date.now();
  const extraDrafts = positiveInt(record.extraDrafts) ?? 0;
  if (extraDrafts <= 0) {
    throw new ApiError(400, "invalid_request", "Missing overage credit.");
  }
  return { now, eventId, extraDrafts };
}

export async function recordPaddleOverageInClerk(
  userId: string,
  body: PaddleOverageBody,
  env: Env,
): Promise<PaddleOverageResult> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }

  const meta = user.privateMetadata ?? {};
  const existingQuota = asRecord(meta.quota) ?? {};
  const processedIds = processedOverageEventIds(existingQuota);
  if (processedIds.includes(body.eventId)) {
    return { idempotent: true };
  }

  const windowStart = mondayStartUtc(body.now);
  const sameWindow = existingQuota.extraDraftsWindowStart === windowStart;
  const prevExtras =
    sameWindow && typeof existingQuota.extraDrafts === "number"
      ? Math.max(0, Math.floor(existingQuota.extraDrafts))
      : 0;

  const quota = {
    ...existingQuota,
    extraDrafts: prevExtras + body.extraDrafts,
    extraDraftsWindowStart: windowStart,
    lastOverageEventId: body.eventId,
    processedOverageEventIds: boundedProcessedOverageEventIds([...processedIds, body.eventId]),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase.");
  }

  return { applied: true, extraDrafts: body.extraDrafts };
}

function processedOverageEventIds(quota: Record<string, unknown>): string[] {
  const ids = Array.isArray(quota.processedOverageEventIds)
    ? quota.processedOverageEventIds.filter(
        (id): id is string => typeof id === "string" && id !== "",
      )
    : [];
  const lastId = quota.lastOverageEventId;
  if (typeof lastId === "string" && lastId !== "" && !ids.includes(lastId)) {
    ids.push(lastId);
  }
  return boundedProcessedOverageEventIds(ids);
}

function boundedProcessedOverageEventIds(ids: string[]): string[] {
  return [...new Set(ids)].slice(-PROCESSED_OVERAGE_EVENT_ID_LIMIT);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
