import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { type Env } from "./config";
import { ApiError } from "./errors";
import { mondayStartUtc } from "./metering";
import { paddleCustomerMatchesAccount } from "./paddle-account";
import type { OverageAdjustmentAction } from "./paddle";

const PROCESSED_OVERAGE_EVENT_ID_LIMIT = 100;
const PROCESSED_OVERAGE_ADJUSTMENT_ID_LIMIT = 100;
const PENDING_OVERAGE_REVERSAL_LIMIT = 100;
export const PADDLE_OVERAGE_CREDITS_STORAGE_KEY = "paddle_overage_credits";

export interface PaddleOverageLedgerStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

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
  hasAdjustmentItems: boolean;
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
  reversedDraftsByAdjustment?: StoredOverageCreditReversal[];
}

interface StoredOverageCreditReversal {
  adjustmentId: string;
  action: "refund" | "chargeback" | "credit";
  drafts: number;
}

interface StoredPendingOverageReversal {
  eventId: string;
  adjustmentId: string;
  transactionId: string;
  action: OverageAdjustmentAction;
  adjustmentType: string | null;
  hasAdjustmentItems?: boolean;
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
    hasAdjustmentItems: record.hasAdjustmentItems === true,
    items: parseAdjustmentItems(record.items),
  };
}

export async function recordPaddleOverageInClerk(
  userId: string,
  body: PaddleOverageBody,
  env: Env,
  ledgerStore?: PaddleOverageLedgerStore,
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
  if (!paddleCustomerMatchesAccount(user, meta, body.customerId, env)) {
    return { mapped: false };
  }

  const existingQuota = asRecord(meta.quota) ?? {};
  const processedIds = processedOverageEventIds(existingQuota);
  if (processedIds.includes(body.eventId)) {
    const repairWindowStart =
      typeof existingQuota.extraDraftsWindowStart === "number"
        ? existingQuota.extraDraftsWindowStart
        : mondayStartUtc(body.now);
    const existingCredits = await loadOverageCredits(existingQuota, ledgerStore);
    await saveOverageCredits(
      ledgerStore,
      mergeOverageCredits([
        ...body.credits.map((credit) =>
          storedCreditFromInput(body.eventId, body.transactionId, credit, repairWindowStart),
        ),
        ...existingCredits,
      ]),
    );
    return { idempotent: true };
  }

  const windowStart = mondayStartUtc(body.now);
  const sameWindow = existingQuota.extraDraftsWindowStart === windowStart;
  const prevExtras =
    sameWindow && typeof existingQuota.extraDrafts === "number"
      ? Math.max(0, Math.floor(existingQuota.extraDrafts))
      : 0;
  const pending = pendingOverageReversals(existingQuota);
  const existingCredits = await loadOverageCredits(existingQuota, ledgerStore);
  let newCredits = body.credits.map((credit) =>
    storedCreditFromInput(body.eventId, body.transactionId, credit, windowStart),
  );
  const replayed = replayPendingAdjustments(
    newCredits,
    pending,
    body.transactionId,
    windowStart,
    null,
  );
  newCredits = replayed.credits;
  const effectiveExtraDrafts = newCredits.reduce((sum, credit) => sum + availableDrafts(credit), 0);
  const allCredits = mergeOverageCredits([...existingCredits, ...newCredits]);

  const quota = {
    ...quotaWithoutOverageCredits(existingQuota),
    extraDrafts: prevExtras + effectiveExtraDrafts,
    extraDraftsWindowStart: windowStart,
    lastOverageEventId: body.eventId,
    processedOverageEventIds: boundedProcessedOverageEventIds([...processedIds, body.eventId]),
    pendingOverageReversals: boundedPendingOverageReversals(replayed.remainingPending),
    ...fallbackOverageCredits(ledgerStore, allCredits),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase.");
  }
  await saveOverageCredits(ledgerStore, allCredits);

  return { applied: true, extraDrafts: effectiveExtraDrafts };
}

export async function revokePaddleOverageInClerk(
  userId: string,
  body: PaddleOverageReversalBody,
  env: Env,
  ledgerStore?: PaddleOverageLedgerStore,
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
  if (!paddleCustomerMatchesAccount(user, meta, body.customerId, env)) {
    return { mapped: false };
  }
  if (body.hasAdjustmentItems && body.items.length === 0) {
    return { ignored: "not_overage_reversal" };
  }

  const existingQuota = asRecord(meta.quota) ?? {};
  const processedAdjustmentIds = processedOverageAdjustmentIds(existingQuota);
  if (processedAdjustmentIds.includes(body.adjustmentId)) {
    const currentWindowStart =
      typeof existingQuota.extraDraftsWindowStart === "number"
        ? existingQuota.extraDraftsWindowStart
        : null;
    const credits = await loadOverageCredits(existingQuota, ledgerStore);
    const applied = applyAdjustmentToCredits(credits, body, currentWindowStart);
    if (applied.extraDrafts > 0) {
      await saveOverageCredits(ledgerStore, applied.credits);
    }
    return { idempotent: true };
  }

  const credits = await loadOverageCredits(existingQuota, ledgerStore);
  const currentWindowStart =
    typeof existingQuota.extraDraftsWindowStart === "number"
      ? existingQuota.extraDraftsWindowStart
      : null;
  const previousExtras =
    typeof existingQuota.extraDrafts === "number"
      ? Math.max(0, Math.floor(existingQuota.extraDrafts))
      : 0;
  const pending = pendingOverageReversals(existingQuota);
  const wasPreviouslyApplied = adjustmentAlreadyAppliedToAnyCredit(credits, body);
  let applied = applyAdjustmentToCredits(credits, body, currentWindowStart);

  if (applied.extraDrafts === 0 && wasPreviouslyApplied) {
    await saveOverageCredits(ledgerStore, credits);
    return { idempotent: true };
  }

  if (applied.extraDrafts === 0) {
    await saveOverageCredits(ledgerStore, credits);
    const quota = {
      ...quotaWithoutOverageCredits(existingQuota),
      processedOverageAdjustmentIds: boundedProcessedOverageAdjustmentIds([
        ...processedAdjustmentIds,
        body.adjustmentId,
      ]),
      pendingOverageReversals: boundedPendingOverageReversals([
        ...pending,
        pendingOverageReversalFromBody(body),
      ]),
      ...fallbackOverageCredits(ledgerStore, credits),
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

  let nextExtras = applyCurrentWindowAdjustment(
    previousExtras,
    body.action,
    applied.currentWindowExtraDrafts,
  );
  const replayed = replayPendingAdjustments(
    applied.credits,
    pending,
    body.transactionId,
    currentWindowStart,
    nextExtras,
  );
  applied = {
    credits: replayed.credits,
    extraDrafts: applied.extraDrafts,
    currentWindowExtraDrafts: applied.currentWindowExtraDrafts,
  };
  nextExtras = replayed.currentExtras ?? nextExtras;

  const quota = {
    ...quotaWithoutOverageCredits(existingQuota),
    extraDrafts: nextExtras,
    processedOverageAdjustmentIds: boundedProcessedOverageAdjustmentIds([
      ...processedAdjustmentIds,
      body.adjustmentId,
    ]),
    pendingOverageReversals: boundedPendingOverageReversals(replayed.remainingPending),
    ...fallbackOverageCredits(ledgerStore, applied.credits),
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch (err) {
    if (isClerkNotFoundError(err)) return { mapped: false };
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase reversal.");
  }
  await saveOverageCredits(ledgerStore, applied.credits);

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
    ...(body.hasAdjustmentItems ? { hasAdjustmentItems: true } : {}),
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
      ? restoreCredit(credit, amount, adjustment.action, adjustment.adjustmentId)
      : reverseCredit(credit, amount, adjustment.action, adjustment.adjustmentId);
  });
  return { credits: adjustedCredits, extraDrafts, currentWindowExtraDrafts };
}

function replayPendingAdjustments(
  credits: StoredOverageCredit[],
  pending: StoredPendingOverageReversal[],
  transactionId: string,
  currentWindowStart: number | null,
  currentExtras: number | null,
): {
  credits: StoredOverageCredit[];
  remainingPending: StoredPendingOverageReversal[];
  currentExtras: number | null;
} {
  let nextCredits = credits;
  let nextCurrentExtras = currentExtras;
  const remaining = pending.filter((item) => item.transactionId !== transactionId);
  let candidates = pending.filter((item) => item.transactionId === transactionId);

  let madeProgress = true;
  while (candidates.length > 0 && madeProgress) {
    madeProgress = false;
    const deferred: StoredPendingOverageReversal[] = [];
    for (const candidate of candidates) {
      const applied = applyAdjustmentToCredits(nextCredits, candidate, currentWindowStart);
      if (applied.extraDrafts <= 0) {
        deferred.push(candidate);
        continue;
      }

      nextCredits = applied.credits;
      if (nextCurrentExtras !== null) {
        nextCurrentExtras = applyCurrentWindowAdjustment(
          nextCurrentExtras,
          candidate.action,
          applied.currentWindowExtraDrafts,
        );
      }
      madeProgress = true;
    }
    candidates = deferred;
  }

  return {
    credits: nextCredits,
    remainingPending: [...remaining, ...candidates],
    currentExtras: nextCurrentExtras,
  };
}

function adjustmentDraftsForCredit(
  credit: StoredOverageCredit,
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
): number {
  if (credit.transactionId !== adjustment.transactionId) return 0;
  if (creditAlreadyAppliedAdjustment(credit, adjustment)) return 0;

  const available = isRestoreAction(adjustment.action)
    ? restorableDrafts(credit, adjustment.action)
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

function adjustmentAlreadyAppliedToAnyCredit(
  credits: StoredOverageCredit[],
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
): boolean {
  return credits.some(
    (credit) =>
      credit.transactionId === adjustment.transactionId &&
      creditAlreadyAppliedAdjustment(credit, adjustment),
  );
}

function creditAlreadyAppliedAdjustment(
  credit: StoredOverageCredit,
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
): boolean {
  if (isRestoreAction(adjustment.action)) {
    return (credit.restoredByAdjustmentIds ?? []).includes(adjustment.adjustmentId);
  }
  return (
    credit.reversedByAdjustmentId === adjustment.adjustmentId ||
    (credit.reversalAdjustmentIds ?? []).includes(adjustment.adjustmentId) ||
    reversedDraftEntries(credit).some((entry) => entry.adjustmentId === adjustment.adjustmentId)
  );
}

function reverseCredit(
  credit: StoredOverageCredit,
  amount: number,
  action: OverageAdjustmentAction,
  adjustmentId: string,
): StoredOverageCredit {
  const previousReversed = reversedDrafts(credit);
  const nextReversed = Math.min(credit.extraDrafts, previousReversed + amount);
  const appliedDrafts = nextReversed - previousReversed;
  return cleanCredit({
    ...credit,
    reversedDrafts: nextReversed,
    reversedByAdjustmentId:
      nextReversed >= credit.extraDrafts ? adjustmentId : credit.reversedByAdjustmentId,
    reversalAdjustmentIds: uniqueIdList([...(credit.reversalAdjustmentIds ?? []), adjustmentId]),
    reversedDraftsByAdjustment: addReversalEntry(
      reversedDraftEntries(credit),
      adjustmentId,
      action,
      appliedDrafts,
    ),
  });
}

function restoreCredit(
  credit: StoredOverageCredit,
  amount: number,
  action: OverageAdjustmentAction,
  adjustmentId: string,
): StoredOverageCredit {
  const consumed = consumeRestorableDrafts(reversedDraftEntries(credit), action, amount);
  return cleanCredit({
    ...credit,
    reversedDrafts: Math.max(0, reversedDrafts(credit) - consumed.restoredDrafts),
    reversedDraftsByAdjustment: consumed.entries,
    restoredByAdjustmentIds: uniqueIdList([
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
    delete out.reversedDraftsByAdjustment;
  } else {
    out.reversedDrafts = reversed;
    if (reversed < out.extraDrafts) delete out.reversedByAdjustmentId;
    const entries = reversedDraftEntries(out);
    if (entries.length > 0) {
      out.reversedDraftsByAdjustment = entries;
    } else {
      delete out.reversedDraftsByAdjustment;
    }
  }
  if (!out.reversalAdjustmentIds?.length) delete out.reversalAdjustmentIds;
  if (!out.restoredByAdjustmentIds?.length) delete out.restoredByAdjustmentIds;
  return out;
}

function coversFullTransaction(
  adjustment: StoredPendingOverageReversal | PaddleOverageReversalBody,
): boolean {
  if (adjustment.hasAdjustmentItems) {
    return adjustment.adjustmentType === "full" && adjustment.items.length > 0;
  }
  return adjustment.adjustmentType === "full" || adjustment.items.length === 0;
}

function isRestoreAction(action: OverageAdjustmentAction): boolean {
  return action === "chargeback_reverse" || action === "credit_reverse";
}

function restorableDrafts(credit: StoredOverageCredit, action: OverageAdjustmentAction): number {
  const target = restoredReversalAction(action);
  if (!target) return 0;
  const drafts = reversedDraftEntries(credit).reduce(
    (sum, entry) => sum + (entry.action === target ? entry.drafts : 0),
    0,
  );
  return Math.min(reversedDrafts(credit), drafts);
}

function restoredReversalAction(
  action: OverageAdjustmentAction,
): StoredOverageCreditReversal["action"] | null {
  if (action === "chargeback_reverse") return "chargeback";
  if (action === "credit_reverse") return "credit";
  return null;
}

function addReversalEntry(
  entries: StoredOverageCreditReversal[],
  adjustmentId: string,
  action: OverageAdjustmentAction,
  drafts: number,
): StoredOverageCreditReversal[] {
  if (drafts <= 0 || !isStoredReversalAction(action)) return entries;
  const next = [...entries];
  const existing = next.find((entry) => entry.adjustmentId === adjustmentId);
  if (existing) {
    existing.drafts += drafts;
  } else {
    next.push({ adjustmentId, action, drafts });
  }
  return next;
}

function consumeRestorableDrafts(
  entries: StoredOverageCreditReversal[],
  action: OverageAdjustmentAction,
  amount: number,
): { entries: StoredOverageCreditReversal[]; restoredDrafts: number } {
  const target = restoredReversalAction(action);
  if (!target || amount <= 0) return { entries, restoredDrafts: 0 };

  let remaining = amount;
  let restoredDrafts = 0;
  const next: StoredOverageCreditReversal[] = [];
  for (const entry of entries) {
    if (entry.action !== target || remaining <= 0) {
      next.push(entry);
      continue;
    }
    const restored = Math.min(entry.drafts, remaining);
    remaining -= restored;
    restoredDrafts += restored;
    const drafts = entry.drafts - restored;
    if (drafts > 0) {
      next.push({ ...entry, drafts });
    }
  }

  return { entries: next, restoredDrafts };
}

function isStoredReversalAction(value: unknown): value is StoredOverageCreditReversal["action"] {
  return value === "refund" || value === "chargeback" || value === "credit";
}

function applyCurrentWindowAdjustment(
  currentExtras: number,
  action: OverageAdjustmentAction,
  amount: number,
): number {
  return isRestoreAction(action) ? currentExtras + amount : Math.max(0, currentExtras - amount);
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

function reversedDraftEntries(credit: StoredOverageCredit): StoredOverageCreditReversal[] {
  const entries = Array.isArray(credit.reversedDraftsByAdjustment)
    ? credit.reversedDraftsByAdjustment
    : [];
  return entries.flatMap((entry): StoredOverageCreditReversal[] => {
    const record = asRecord(entry);
    if (!record) return [];
    const adjustmentId = nullableId(record.adjustmentId);
    const action = isStoredReversalAction(record.action) ? record.action : null;
    const drafts = positiveInt(record.drafts);
    if (!adjustmentId || !action || !drafts) return [];
    return [{ adjustmentId, action, drafts }];
  });
}

function uniqueIdList(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id !== ""))];
}

async function loadOverageCredits(
  quota: Record<string, unknown>,
  ledgerStore: PaddleOverageLedgerStore | undefined,
): Promise<StoredOverageCredit[]> {
  const legacyCredits = overageCreditsFromValue(quota.overageCredits);
  if (!ledgerStore) return mergeOverageCredits(legacyCredits);
  const storedCredits = overageCreditsFromValue(
    await ledgerStore.get<unknown>(PADDLE_OVERAGE_CREDITS_STORAGE_KEY),
  );
  return mergeOverageCredits([...legacyCredits, ...storedCredits]);
}

async function saveOverageCredits(
  ledgerStore: PaddleOverageLedgerStore | undefined,
  credits: StoredOverageCredit[],
): Promise<void> {
  if (!ledgerStore) return;
  await ledgerStore.put(PADDLE_OVERAGE_CREDITS_STORAGE_KEY, mergeOverageCredits(credits));
}

function fallbackOverageCredits(
  ledgerStore: PaddleOverageLedgerStore | undefined,
  credits: StoredOverageCredit[],
): { overageCredits?: StoredOverageCredit[] } {
  return ledgerStore ? {} : { overageCredits: mergeOverageCredits(credits) };
}

function quotaWithoutOverageCredits(quota: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...quota };
  delete rest.overageCredits;
  return rest;
}

function mergeOverageCredits(credits: StoredOverageCredit[]): StoredOverageCredit[] {
  const byCredit = new Map<string, StoredOverageCredit>();
  for (const credit of credits) {
    byCredit.set(overageCreditKey(credit), credit);
  }
  return [...byCredit.values()];
}

function overageCreditKey(credit: StoredOverageCredit): string {
  return `${credit.eventId}:${credit.transactionId}:${credit.transactionItemId ?? ""}`;
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
    (record.hasAdjustmentItems === undefined || typeof record.hasAdjustmentItems === "boolean") &&
    Array.isArray(record.items)
  );
}

function overageCreditsFromValue(value: unknown): StoredOverageCredit[] {
  const credits = Array.isArray(value) ? value : [];
  return credits.filter(isStoredOverageCredit);
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
