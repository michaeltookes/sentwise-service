import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { type Env } from "./config";
import { ApiError } from "./errors";
import { mondayStartUtc } from "./metering";
import { paddleCustomerMatchesAccount } from "./paddle-account";

const PROCESSED_OVERAGE_EVENT_ID_LIMIT = 100;
const PROCESSED_OVERAGE_ADJUSTMENT_ID_LIMIT = 100;
const OVERAGE_CREDIT_LIMIT = 100;

export interface PaddleOverageBody {
  now: number;
  eventId: string;
  transactionId: string;
  customerId: string | null;
  extraDrafts: number;
}

export interface PaddleOverageReversalBody {
  now: number;
  eventId: string;
  adjustmentId: string;
  transactionId: string;
  customerId: string | null;
}

interface StoredOverageCredit {
  eventId: string;
  transactionId: string;
  extraDrafts: number;
  windowStart: number;
  reversedByAdjustmentId?: string;
}

export type PaddleOverageResult =
  { applied: true; extraDrafts: number } | { idempotent: true } | { mapped: false };
export type PaddleOverageReversalResult =
  | { revoked: true; extraDrafts: number }
  | { idempotent: true }
  | { ignored: "not_overage_reversal" }
  | { mapped: false };

export function parsePaddleOverageBody(body: unknown): PaddleOverageBody {
  const record = asRecord(body);
  if (!record) {
    throw new ApiError(400, "invalid_request", "Request body must be an object.");
  }
  const eventId = record.eventId;
  if (typeof eventId !== "string" || eventId === "") {
    throw new ApiError(400, "invalid_request", "Missing overage event id.");
  }
  const transactionId = record.transactionId;
  if (typeof transactionId !== "string" || transactionId === "") {
    throw new ApiError(400, "invalid_request", "Missing overage transaction id.");
  }
  const customerId = nullableId(record.customerId);
  const now = positiveInt(record.now) ?? Date.now();
  const extraDrafts = positiveInt(record.extraDrafts) ?? 0;
  if (extraDrafts <= 0) {
    throw new ApiError(400, "invalid_request", "Missing overage credit.");
  }
  return { now, eventId, transactionId, customerId, extraDrafts };
}

export function parsePaddleOverageReversalBody(body: unknown): PaddleOverageReversalBody {
  const record = asRecord(body);
  if (!record) {
    throw new ApiError(400, "invalid_request", "Request body must be an object.");
  }
  const eventId = record.eventId;
  const adjustmentId = record.adjustmentId;
  const transactionId = record.transactionId;
  if (typeof eventId !== "string" || eventId === "") {
    throw new ApiError(400, "invalid_request", "Missing adjustment event id.");
  }
  if (typeof adjustmentId !== "string" || adjustmentId === "") {
    throw new ApiError(400, "invalid_request", "Missing adjustment id.");
  }
  if (typeof transactionId !== "string" || transactionId === "") {
    throw new ApiError(400, "invalid_request", "Missing adjusted transaction id.");
  }
  return {
    now: positiveInt(record.now) ?? Date.now(),
    eventId,
    adjustmentId,
    transactionId,
    customerId: nullableId(record.customerId),
  };
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
  if (!(await paddleCustomerMatchesAccount(user, meta, body.customerId, env))) {
    return { mapped: false };
  }

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
    overageCredits: boundedOverageCredits([
      ...overageCredits(existingQuota),
      {
        eventId: body.eventId,
        transactionId: body.transactionId,
        extraDrafts: body.extraDrafts,
        windowStart,
      },
    ]),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase.");
  }

  return { applied: true, extraDrafts: body.extraDrafts };
}

export async function revokePaddleOverageInClerk(
  userId: string,
  body: PaddleOverageReversalBody,
  env: Env,
): Promise<PaddleOverageReversalResult> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }

  const meta = user.privateMetadata ?? {};
  if (!(await paddleCustomerMatchesAccount(user, meta, body.customerId, env))) {
    return { mapped: false };
  }

  const existingQuota = asRecord(meta.quota) ?? {};
  const processedAdjustmentIds = processedOverageAdjustmentIds(existingQuota);
  if (processedAdjustmentIds.includes(body.adjustmentId)) {
    return { idempotent: true };
  }

  const credits = overageCredits(existingQuota);
  const matchingCredits = credits.filter(
    (credit) => credit.transactionId === body.transactionId && !credit.reversedByAdjustmentId,
  );
  if (matchingCredits.length === 0) {
    return { ignored: "not_overage_reversal" };
  }

  const currentWindowStart =
    typeof existingQuota.extraDraftsWindowStart === "number"
      ? existingQuota.extraDraftsWindowStart
      : null;
  const currentWindowRevokeAmount = matchingCredits
    .filter((credit) => credit.windowStart === currentWindowStart)
    .reduce((sum, credit) => sum + credit.extraDrafts, 0);
  const previousExtras =
    typeof existingQuota.extraDrafts === "number"
      ? Math.max(0, Math.floor(existingQuota.extraDrafts))
      : 0;
  const totalRevokeAmount = matchingCredits.reduce((sum, credit) => sum + credit.extraDrafts, 0);

  const quota = {
    ...existingQuota,
    extraDrafts: Math.max(0, previousExtras - currentWindowRevokeAmount),
    processedOverageAdjustmentIds: boundedProcessedOverageAdjustmentIds([
      ...processedAdjustmentIds,
      body.adjustmentId,
    ]),
    overageCredits: boundedOverageCredits(
      credits.map((credit) =>
        credit.transactionId === body.transactionId && !credit.reversedByAdjustmentId
          ? { ...credit, reversedByAdjustmentId: body.adjustmentId }
          : credit,
      ),
    ),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase reversal.");
  }

  return { revoked: true, extraDrafts: totalRevokeAmount };
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

function processedOverageAdjustmentIds(quota: Record<string, unknown>): string[] {
  const ids = Array.isArray(quota.processedOverageAdjustmentIds)
    ? quota.processedOverageAdjustmentIds.filter(
        (id): id is string => typeof id === "string" && id !== "",
      )
    : [];
  return boundedProcessedOverageAdjustmentIds(ids);
}

function boundedProcessedOverageAdjustmentIds(ids: string[]): string[] {
  return [...new Set(ids)].slice(-PROCESSED_OVERAGE_ADJUSTMENT_ID_LIMIT);
}

function overageCredits(quota: Record<string, unknown>): StoredOverageCredit[] {
  const credits = Array.isArray(quota.overageCredits) ? quota.overageCredits : [];
  return boundedOverageCredits(credits.filter(isStoredOverageCredit));
}

function boundedOverageCredits(credits: StoredOverageCredit[]): StoredOverageCredit[] {
  return credits.slice(-OVERAGE_CREDIT_LIMIT);
}

function isStoredOverageCredit(value: unknown): value is StoredOverageCredit {
  const record = asRecord(value);
  if (!record) return false;
  const reversedByAdjustmentId = record.reversedByAdjustmentId;
  return (
    typeof record.eventId === "string" &&
    record.eventId !== "" &&
    typeof record.transactionId === "string" &&
    record.transactionId !== "" &&
    typeof record.extraDrafts === "number" &&
    Number.isFinite(record.extraDrafts) &&
    record.extraDrafts > 0 &&
    typeof record.windowStart === "number" &&
    Number.isFinite(record.windowStart) &&
    record.windowStart > 0 &&
    (reversedByAdjustmentId === undefined ||
      (typeof reversedByAdjustmentId === "string" && reversedByAdjustmentId !== ""))
  );
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function nullableId(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
