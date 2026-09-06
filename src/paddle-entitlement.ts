import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { type Env } from "./config";
import { ApiError } from "./errors";
import { mondayStartUtc } from "./metering";
import { paddleCustomerMatchesAccount } from "./paddle-account";
import type { OverageAdjustmentAction } from "./paddle";

const PROCESSED_OVERAGE_EVENT_ID_LIMIT = 100;
const PROCESSED_OVERAGE_ADJUSTMENT_ID_LIMIT = 100;
const OVERAGE_CREDIT_LIMIT = 100;
const PENDING_OVERAGE_REVERSAL_LIMIT = 100;

export interface PaddleOverageCreditInput {
  transactionItemId: string | null;
  extraDrafts: number;
  amount: number | null;
}

export interface PaddleOverageBody {
  now: number;
  eventId: string;
  transactionId: string;
  customerId: string | null;
  extraDrafts: number;
  credits: PaddleOverageCreditInput[];
}

export interface PaddleOverageAdjustmentItemInput {
  transactionItemId: string;
  type: "full" | "partial";
  amount: number | null;
}

export interface PaddleOverageReversalBody {
  now: number;
  eventId: string;
  adjustmentId: string;
  transactionId: string;
  customerId: string | null;
  action: OverageAdjustmentAction;
  adjustmentType: string | null;
  items: PaddleOverageAdjustmentItemInput[];
}

interface StoredOverageCredit {
  eventId: string;
  transactionId: string;
  transactionItemId?: string;
  extraDrafts: number;
  amount?: number;
  windowStart: number;
  reversedDrafts?: number;
  reversedByAdjustmentId?: string;
  reversalAdjustmentIds?: string[];
  restoredByAdjustmentIds?: string[];
}

interface StoredPendingOverageReversal {
  eventId: string;
  adjustmentId: string;
  transactionId: string;
  action: OverageAdjustmentAction;
  adjustmentType: string | null;
  items: PaddleOverageAdjustmentItemInput[];
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
  const credits = parseOverageCreditInputs(record.credits, extraDrafts);
  return {
    now,
    eventId,
    transactionId,
    customerId,
    extraDrafts: credits.reduce((sum, credit) => sum + credit.extraDrafts, 0),
    credits,
  };
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
  const action = parseOverageAdjustmentAction(record.action);
  if (!action) {
    throw new ApiError(400, "invalid_request", "Missing adjustment action.");
  }
  return {
    now: positiveInt(record.now) ?? Date.now(),
    eventId,
    adjustmentId,
    transactionId,
    customerId: nullableId(record.customerId),
    action,
    adjustmentType: typeof record.adjustmentType === "string" ? record.adjustmentType : null,
    items: parseAdjustmentItems(record.items),
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
  const pending = pendingOverageReversals(existingQuota);
  let newCredits = body.credits.map((credit) =>
    storedCreditFromInput(body.eventId, body.transactionId, credit, windowStart),
  );
  const remainingPending: StoredPendingOverageReversal[] = [];
  for (const pendingReversal of pending) {
    if (pendingReversal.transactionId !== body.transactionId) {
      remainingPending.push(pendingReversal);
      continue;
    }
    newCredits = applyAdjustmentToCredits(newCredits, pendingReversal, windowStart).credits;
  }
  const effectiveExtraDrafts = newCredits.reduce((sum, credit) => sum + availableDrafts(credit), 0);

  const quota = {
    ...existingQuota,
    extraDrafts: prevExtras + effectiveExtraDrafts,
    extraDraftsWindowStart: windowStart,
    lastOverageEventId: body.eventId,
    processedOverageEventIds: boundedProcessedOverageEventIds([...processedIds, body.eventId]),
    pendingOverageReversals: boundedPendingOverageReversals(remainingPending),
    overageCredits: boundedOverageCredits([...overageCredits(existingQuota), ...newCredits]),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase.");
  }

  return { applied: true, extraDrafts: effectiveExtraDrafts };
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
  const currentWindowStart =
    typeof existingQuota.extraDraftsWindowStart === "number"
      ? existingQuota.extraDraftsWindowStart
      : null;
  const previousExtras =
    typeof existingQuota.extraDrafts === "number"
      ? Math.max(0, Math.floor(existingQuota.extraDrafts))
      : 0;
  const applied = applyAdjustmentToCredits(credits, body, currentWindowStart);

  if (applied.extraDrafts === 0) {
    if (isReversalAction(body.action)) {
      const quota = {
        ...existingQuota,
        processedOverageAdjustmentIds: boundedProcessedOverageAdjustmentIds([
          ...processedAdjustmentIds,
          body.adjustmentId,
        ]),
        pendingOverageReversals: boundedPendingOverageReversals([
          ...pendingOverageReversals(existingQuota),
          pendingOverageReversalFromBody(body),
        ]),
      };
      try {
        await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
      } catch (err) {
        if (isClerkNotFoundError(err)) return { mapped: false };
        throw new ApiError(
          502,
          "entitlement_write_failed",
          "Could not record the purchase reversal.",
        );
      }
      return { pending: true };
    }
    return { ignored: "not_overage_reversal" };
  }

  const nextExtras = isRestoreAction(body.action)
    ? previousExtras + applied.currentWindowExtraDrafts
    : Math.max(0, previousExtras - applied.currentWindowExtraDrafts);

  const quota = {
    ...existingQuota,
    extraDrafts: nextExtras,
    processedOverageAdjustmentIds: boundedProcessedOverageAdjustmentIds([
      ...processedAdjustmentIds,
      body.adjustmentId,
    ]),
    overageCredits: boundedOverageCredits(applied.credits),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase reversal.");
  }

  return isRestoreAction(body.action)
    ? { restored: true, extraDrafts: applied.extraDrafts }
    : { revoked: true, extraDrafts: applied.extraDrafts };
}

function parseOverageCreditInputs(
  value: unknown,
  fallbackExtraDrafts: number,
): PaddleOverageCreditInput[] {
  const credits = Array.isArray(value) ? value.map(parseOverageCreditInput).filter(isDefined) : [];
  if (credits.length > 0) return credits;
  return [{ transactionItemId: null, extraDrafts: fallbackExtraDrafts, amount: null }];
}

function parseOverageCreditInput(value: unknown): PaddleOverageCreditInput | null {
  const record = asRecord(value);
  if (!record) return null;
  const extraDrafts = positiveInt(record.extraDrafts) ?? 0;
  if (extraDrafts <= 0) return null;
  return {
    transactionItemId: nullableId(record.transactionItemId),
    extraDrafts,
    amount: positiveInt(record.amount),
  };
}

function parseAdjustmentItems(value: unknown): PaddleOverageAdjustmentItemInput[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseAdjustmentItem).filter(isDefined);
}

function parseAdjustmentItem(value: unknown): PaddleOverageAdjustmentItemInput | null {
  const record = asRecord(value);
  if (!record) return null;
  const transactionItemId = nullableId(record.transactionItemId);
  if (!transactionItemId) return null;
  const type = record.type === "partial" ? "partial" : record.type === "full" ? "full" : null;
  if (!type) return null;
  return {
    transactionItemId,
    type,
    amount: positiveInt(record.amount),
  };
}

function parseOverageAdjustmentAction(value: unknown): OverageAdjustmentAction | null {
  switch (value) {
    case "refund":
    case "chargeback":
    case "credit":
    case "chargeback_reverse":
    case "credit_reverse":
      return value;
    default:
      return null;
  }
}

function storedCreditFromInput(
  eventId: string,
  transactionId: string,
  input: PaddleOverageCreditInput,
  windowStart: number,
): StoredOverageCredit {
  return cleanCredit({
    eventId,
    transactionId,
    ...(input.transactionItemId ? { transactionItemId: input.transactionItemId } : {}),
    extraDrafts: input.extraDrafts,
    ...(input.amount !== null ? { amount: input.amount } : {}),
    windowStart,
  });
}

function pendingOverageReversalFromBody(
  body: PaddleOverageReversalBody,
): StoredPendingOverageReversal {
  return {
    eventId: body.eventId,
    adjustmentId: body.adjustmentId,
    transactionId: body.transactionId,
    action: body.action,
    adjustmentType: body.adjustmentType,
    items: body.items,
  };
}

function applyAdjustmentToCredits(
  credits: StoredOverageCredit[],
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
  currentWindowStart: number | null,
): {
  credits: StoredOverageCredit[];
  extraDrafts: number;
  currentWindowExtraDrafts: number;
} {
  let extraDrafts = 0;
  let currentWindowExtraDrafts = 0;
  const adjustedCredits = credits.map((credit) => {
    const amount = adjustmentDraftsForCredit(credit, adjustment);
    if (amount <= 0) return credit;

    extraDrafts += amount;
    if (credit.windowStart === currentWindowStart) {
      currentWindowExtraDrafts += amount;
    }

    return isRestoreAction(adjustment.action)
      ? restoreCredit(credit, amount, adjustment.adjustmentId)
      : reverseCredit(credit, amount, adjustment.adjustmentId);
  });
  return { credits: adjustedCredits, extraDrafts, currentWindowExtraDrafts };
}

function adjustmentDraftsForCredit(
  credit: StoredOverageCredit,
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
): number {
  if (credit.transactionId !== adjustment.transactionId) return 0;

  const available = isRestoreAction(adjustment.action)
    ? reversedDrafts(credit)
    : availableDrafts(credit);
  if (available <= 0) return 0;
  if (coversFullTransaction(adjustment)) return available;

  const item = adjustment.items.find(
    (candidate) =>
      !!credit.transactionItemId && candidate.transactionItemId === credit.transactionItemId,
  );
  if (!item) return 0;
  if (item.type === "full") return available;
  if (item.amount !== null && credit.amount && credit.amount > 0) {
    const prorated = Math.ceil((credit.extraDrafts * item.amount) / credit.amount);
    return Math.min(available, Math.max(1, prorated));
  }
  return available;
}

function reverseCredit(
  credit: StoredOverageCredit,
  amount: number,
  adjustmentId: string,
): StoredOverageCredit {
  const nextReversed = Math.min(credit.extraDrafts, reversedDrafts(credit) + amount);
  return cleanCredit({
    ...credit,
    reversedDrafts: nextReversed,
    reversedByAdjustmentId:
      nextReversed >= credit.extraDrafts ? adjustmentId : credit.reversedByAdjustmentId,
    reversalAdjustmentIds: boundedIdList([...(credit.reversalAdjustmentIds ?? []), adjustmentId]),
  });
}

function restoreCredit(
  credit: StoredOverageCredit,
  amount: number,
  adjustmentId: string,
): StoredOverageCredit {
  return cleanCredit({
    ...credit,
    reversedDrafts: Math.max(0, reversedDrafts(credit) - amount),
    restoredByAdjustmentIds: boundedIdList([
      ...(credit.restoredByAdjustmentIds ?? []),
      adjustmentId,
    ]),
  });
}

function cleanCredit(credit: StoredOverageCredit): StoredOverageCredit {
  const out: StoredOverageCredit = { ...credit };
  if (!out.transactionItemId) delete out.transactionItemId;
  if (!out.amount || out.amount <= 0) delete out.amount;
  const reversed = reversedDrafts(out);
  if (reversed <= 0) {
    delete out.reversedDrafts;
    delete out.reversedByAdjustmentId;
  } else {
    out.reversedDrafts = reversed;
    if (reversed < out.extraDrafts) delete out.reversedByAdjustmentId;
  }
  if (!out.reversalAdjustmentIds?.length) delete out.reversalAdjustmentIds;
  if (!out.restoredByAdjustmentIds?.length) delete out.restoredByAdjustmentIds;
  return out;
}

function coversFullTransaction(
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
): boolean {
  return adjustment.adjustmentType === "full" || adjustment.items.length === 0;
}

function isReversalAction(action: OverageAdjustmentAction): boolean {
  return action === "refund" || action === "chargeback" || action === "credit";
}

function isRestoreAction(action: OverageAdjustmentAction): boolean {
  return action === "chargeback_reverse" || action === "credit_reverse";
}

function availableDrafts(credit: StoredOverageCredit): number {
  return Math.max(0, credit.extraDrafts - reversedDrafts(credit));
}

function reversedDrafts(credit: StoredOverageCredit): number {
  if (typeof credit.reversedDrafts === "number" && Number.isFinite(credit.reversedDrafts)) {
    return Math.min(credit.extraDrafts, Math.max(0, Math.floor(credit.reversedDrafts)));
  }
  return credit.reversedByAdjustmentId ? credit.extraDrafts : 0;
}

function boundedIdList(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id !== ""))].slice(-10);
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

function pendingOverageReversals(quota: Record<string, unknown>): StoredPendingOverageReversal[] {
  const pending = Array.isArray(quota.pendingOverageReversals) ? quota.pendingOverageReversals : [];
  return boundedPendingOverageReversals(pending.filter(isStoredPendingOverageReversal));
}

function boundedPendingOverageReversals(
  pending: StoredPendingOverageReversal[],
): StoredPendingOverageReversal[] {
  const byAdjustmentId = new Map<string, StoredPendingOverageReversal>();
  for (const item of pending) {
    byAdjustmentId.set(item.adjustmentId, item);
  }
  return [...byAdjustmentId.values()].slice(-PENDING_OVERAGE_REVERSAL_LIMIT);
}

function isStoredPendingOverageReversal(value: unknown): value is StoredPendingOverageReversal {
  const record = asRecord(value);
  if (!record) return false;
  const action = parseOverageAdjustmentAction(record.action);
  if (!action) return false;
  return (
    typeof record.eventId === "string" &&
    record.eventId !== "" &&
    typeof record.adjustmentId === "string" &&
    record.adjustmentId !== "" &&
    typeof record.transactionId === "string" &&
    record.transactionId !== "" &&
    (record.adjustmentType === null ||
      record.adjustmentType === undefined ||
      typeof record.adjustmentType === "string") &&
    Array.isArray(record.items)
  );
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

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
