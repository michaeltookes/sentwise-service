// AccountQuota Durable Object (56b). One instance per Clerk userId
// (`idFromName(userId)`). Stores ONLY counters, timestamps, and random
// reservation IDs for settlement dedupe — never prompts, never draft content,
// never emails.
//
// Storage keys:
//   "window" -> WindowState  (weekly usage, in-flight token reservations, reset timestamps)
//   "rate"   -> number[]     (recent request timestamps, sliding 60s window)
//   "pending_settlement:<reservationId>" -> PendingSettlement (alarm-retried settlement metadata)
//   "settled_settlement:<reservationId>" -> SettledSettlementMarker (idempotency marker)
//   "account_deletion" -> deletion barrier/tombstone for stale authenticated requests
//
// The Worker calls these ops over the DO's internal fetch (see quota-client.ts):
//   POST /check   { now, rateLimitPerMin } -> { allowed, retryAfterSeconds, window }
//   POST /reserve { now, reservationId, estimatedTokens, limits } -> { reserved, ... }
//   POST /settle  { now, reservationId, reservationWindowStart, estimatedTokens, tokensDelta }
//   POST /defer-settlement { now, reservationId, reservationWindowStart, estimatedTokens, tokensDelta }
//   POST /release { now, reservationId, reservationWindowStart, estimatedTokens } -> { window }
//   POST /peek    { now } -> { window }   (read + roll only; no rate-limit, no increment)
//   POST /begin-delete  { now } -> block future quota reads/mutations without wiping counters
//   POST /cancel-delete { now } -> remove an in-progress barrier after Clerk deletion fails
//   POST /finish-delete { now } -> wipe counters and keep a deleted tombstone
//   POST /wipe    {} -> compatibility alias for /finish-delete

import type { Env } from "./config";
import { jsonError } from "./errors";
import {
  activeReservations,
  pruneStamps,
  pruneExpiredReservations,
  RESERVATION_TTL_MS,
  reservedTokens,
  rollWindow,
  RATE_WINDOW_MS,
  wouldExceedQuota,
  type ResolvedLimits,
  type WindowState,
} from "./metering";

interface CheckBody {
  now: number;
  rateLimitPerMin: number;
}
interface SettleBody {
  now: number;
  reservationId?: string;
  reservationWindowStart?: number;
  estimatedTokens?: number;
  draftsDelta?: number;
  tokensDelta: number;
}
interface ReserveBody {
  now: number;
  reservationId: string;
  estimatedTokens: number;
  limits: ResolvedLimits;
}
interface ReleaseBody {
  now: number;
  reservationId?: string;
  estimatedTokens: number;
  reservationWindowStart: number;
}
interface PeekBody {
  now: number;
}
interface DeletionBody {
  now?: number;
}
interface PendingSettlement {
  reservationId: string;
  reservationWindowStart: number;
  estimatedTokens: number;
  tokensDelta: number;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
}
interface SettledSettlementMarker {
  settledAt: number;
}
interface AccountDeletionMarker {
  status: "deleting" | "deleted";
  updatedAt: number;
}
interface StorageReader {
  get<T = unknown>(key: string): Promise<T | undefined>;
}
interface StorageWriter extends StorageReader {
  put<T = unknown>(key: string, value: T): Promise<void>;
}

const ACCOUNT_DELETION_KEY = "account_deletion";
const LEGACY_PENDING_SETTLEMENTS_KEY = "pending_settlements";
const PENDING_SETTLEMENT_KEY_PREFIX = "pending_settlement:";
const SETTLED_SETTLEMENT_KEY_PREFIX = "settled_settlement:";
const SETTLED_MARKER_PRUNE_AT_KEY = "settled_settlement_prune_at";
const SETTLEMENT_RETRY_BASE_DELAY_MS = 60_000;
const SETTLEMENT_RETRY_MAX_DELAY_MS = 15 * 60_000;
const SETTLEMENT_MARKER_RETENTION_MS = RESERVATION_TTL_MS + SETTLEMENT_RETRY_MAX_DELAY_MS;
const SETTLEMENT_MARKER_PRUNE_INTERVAL_MS = SETTLEMENT_RETRY_MAX_DELAY_MS;

export class AccountQuota {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, _env: Env) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/begin-delete":
        return this.handleBeginDelete(await request.json<DeletionBody>());
      case "/cancel-delete":
        return this.handleCancelDelete();
      case "/finish-delete":
        return this.handleFinishDelete(await request.json<DeletionBody>());
      case "/wipe":
        return this.handleWipe();
    }

    const deletion = await this.loadAccountDeletionMarker();
    if (deletion) {
      return accountDeletionResponse(deletion);
    }

    switch (pathname) {
      case "/check":
        return this.handleCheck(await request.json<CheckBody>());
      case "/reserve":
        return this.handleReserve(await request.json<ReserveBody>());
      case "/settle":
        return this.handleSettle(await request.json<SettleBody>());
      case "/defer-settlement":
        return this.handleDeferSettlement(await request.json<SettleBody>());
      case "/release":
        return this.handleRelease(await request.json<ReleaseBody>());
      case "/peek":
        return this.handlePeek(await request.json<PeekBody>());
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const deletion = await this.loadAccountDeletionMarker();
    if (deletion) {
      if (deletion.status === "deleted") {
        await this.storage.deleteAlarm();
      }
      return;
    }
    await this.processPendingSettlements(Date.now());
  }

  private async loadWindowFrom(storage: StorageReader, now: number): Promise<WindowState> {
    const stored = await storage.get<WindowState>("window");
    return rollWindow(stored, now);
  }

  private async handleCheck(body: CheckBody): Promise<Response> {
    return this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion) return accountDeletionResponse(deletion);

      const window = await this.loadWindowFrom(txn, body.now);
      let stamps = pruneStamps((await txn.get<number[]>("rate")) ?? [], body.now);
      let allowed = true;
      let retryAfterSeconds = 0;
      if (stamps.length >= body.rateLimitPerMin) {
        allowed = false;
        const oldest = stamps[0];
        retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - body.now) / 1000));
      } else {
        stamps = [...stamps, body.now];
      }

      await txn.put("window", window);
      await txn.put("rate", stamps);
      return Response.json({ allowed, retryAfterSeconds, window });
    });
  }

  private async handleReserve(body: ReserveBody): Promise<Response> {
    return this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion) return accountDeletionResponse(deletion);

      const window = await this.loadWindowFrom(txn, body.now);
      const estimatedTokens = nonNegativeInt(body.estimatedTokens);
      if (
        body.limits.enforcement === "hard" &&
        wouldExceedQuota(window, body.limits, 1, estimatedTokens)
      ) {
        await txn.put("window", window);
        return Response.json({
          reserved: false,
          blockedByQuota: true,
          reservationId: body.reservationId,
          estimatedTokens,
          window,
        });
      }

      window.draftsUsed += 1;
      window.tokensReserved = reservedTokens(window) + estimatedTokens;
      window.activeReservations = [
        ...activeReservations(window),
        {
          id: body.reservationId,
          estimatedTokens,
          expiresAt: body.now + RESERVATION_TTL_MS,
        },
      ];
      await txn.put("window", window);
      return Response.json({
        reserved: true,
        blockedByQuota: false,
        reservationId: body.reservationId,
        estimatedTokens,
        window,
      });
    });
  }

  private async handleSettle(body: SettleBody): Promise<Response> {
    let window: WindowState;
    try {
      window = await this.applySettlement(body);
    } catch (err) {
      if (err instanceof AccountDeletionBlockedError) {
        return accountDeletionResponse(err.marker);
      }
      throw err;
    }
    await this.maybePruneSettledSettlementMarkers(body.now).catch(() => undefined);
    return Response.json({ window });
  }

  private async handleDeferSettlement(body: SettleBody): Promise<Response> {
    if (!body.reservationId || body.reservationWindowStart === undefined) {
      return new Response("reservation id and window required", { status: 400 });
    }
    const result = await this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion) return { queued: false, response: accountDeletionResponse(deletion) };

      await this.putPendingSettlement(txn, {
        reservationId: body.reservationId!,
        reservationWindowStart: nonNegativeInt(body.reservationWindowStart),
        estimatedTokens: nonNegativeInt(body.estimatedTokens),
        tokensDelta: nonNegativeInt(body.tokensDelta),
        attempts: 0,
        createdAt: body.now,
        nextAttemptAt: body.now,
      });
      return {
        queued: true,
        response: Response.json({ window: await this.loadWindowFrom(txn, body.now), queued: true }),
      };
    });
    if (result.queued) {
      await this.schedulePendingSettlementAlarm();
    }
    return result.response;
  }

  private async applySettlement(body: SettleBody): Promise<WindowState> {
    return this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion) {
        throw new AccountDeletionBlockedError(deletion);
      }

      const { window, appliesToStoredReservation } = await this.loadMutationWindowFrom(
        txn,
        body.now,
        body.reservationWindowStart,
      );
      if (appliesToStoredReservation) {
        const reservationId = normalizedId(body.reservationId);
        const marker = reservationId
          ? await txn.get<SettledSettlementMarker>(settledSettlementKey(reservationId))
          : undefined;
        const alreadySettled =
          reservationId !== undefined &&
          ((window.settledReservationIds ?? []).includes(reservationId) ||
            isSettledSettlementMarker(marker));

        if (!alreadySettled) {
          const active = activeReservations(window);
          const reservation = active.find((r) => r.id === reservationId);
          const estimatedTokens =
            reservation?.estimatedTokens ?? nonNegativeInt(body.estimatedTokens);
          const draftsDelta = body.draftsDelta ?? (reservationId && !reservation ? 1 : 0);
          window.draftsUsed = Math.max(0, window.draftsUsed + draftsDelta);
          window.tokensReserved = Math.max(0, reservedTokens(window) - estimatedTokens);
          window.tokensUsed = Math.max(0, window.tokensUsed + body.tokensDelta);
          if (reservationId) {
            window.activeReservations = active.filter((r) => r.id !== reservationId);
            await txn.put(settledSettlementKey(reservationId), { settledAt: body.now });
          }
        }
      }
      await txn.put("window", window);
      return window;
    });
  }

  private async handleRelease(body: ReleaseBody): Promise<Response> {
    return this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion) return accountDeletionResponse(deletion);

      const { window, appliesToStoredReservation } = await this.loadMutationWindowFrom(
        txn,
        body.now,
        body.reservationWindowStart,
      );
      if (appliesToStoredReservation) {
        const active = activeReservations(window);
        const reservation = active.find((r) => r.id === body.reservationId);
        if (!body.reservationId || reservation) {
          const estimatedTokens =
            reservation?.estimatedTokens ?? nonNegativeInt(body.estimatedTokens);
          window.draftsUsed = Math.max(0, window.draftsUsed - 1);
          window.tokensReserved = Math.max(0, reservedTokens(window) - estimatedTokens);
          if (body.reservationId) {
            window.activeReservations = active.filter((r) => r.id !== body.reservationId);
          }
        }
      }
      await txn.put("window", window);
      return Response.json({ window });
    });
  }

  private async handlePeek(body: PeekBody): Promise<Response> {
    return this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion) return accountDeletionResponse(deletion);

      const window = await this.loadWindowFrom(txn, body.now);
      await txn.put("window", window);
      return Response.json({ window });
    });
  }

  // 73: account deletion is two-phase. Begin sets a barrier before Clerk deletion
  // so authenticated in-flight requests cannot mutate or recreate quota state.
  // Finish erases usage data and keeps a tiny tombstone that blocks stale tokens
  // after Clerk deletion has succeeded.
  private async handleBeginDelete(body: DeletionBody): Promise<Response> {
    const now = normalizedNow(body.now);
    const current = await this.loadAccountDeletionMarker();
    if (current?.status === "deleted") {
      return Response.json({ deleting: true, alreadyDeleted: true });
    }
    await this.storage.put(ACCOUNT_DELETION_KEY, { status: "deleting", updatedAt: now });
    return Response.json({ deleting: true, alreadyDeleted: false });
  }

  private async handleCancelDelete(): Promise<Response> {
    const current = await this.loadAccountDeletionMarker();
    if (current?.status === "deleting") {
      await this.storage.delete(ACCOUNT_DELETION_KEY);
      await this.schedulePendingSettlementAlarm();
      return Response.json({ cancelled: true });
    }
    return Response.json({ cancelled: false });
  }

  private async handleFinishDelete(body: DeletionBody): Promise<Response> {
    const now = normalizedNow(body.now);
    await this.storage.put(ACCOUNT_DELETION_KEY, { status: "deleted", updatedAt: now });
    await this.deleteAccountDataExceptDeletionMarker();
    return Response.json({ deleted: true });
  }

  // Compatibility for existing internal callers: wipe now means final deletion,
  // not "reset quota and allow a fresh window".
  private async handleWipe(): Promise<Response> {
    await this.handleFinishDelete({ now: Date.now() });
    return Response.json({ wiped: true, deleted: true });
  }

  private async deleteAccountDataExceptDeletionMarker(): Promise<void> {
    const keys = [...(await this.storage.list()).keys()].filter(
      (key) => key !== ACCOUNT_DELETION_KEY,
    );
    if (keys.length > 0) {
      await this.storage.delete(keys);
    }
    await this.storage.put(ACCOUNT_DELETION_KEY, {
      status: "deleted",
      updatedAt: Date.now(),
    });
    await this.storage.deleteAlarm();
  }

  private async loadAccountDeletionMarker(): Promise<AccountDeletionMarker | undefined> {
    return this.loadAccountDeletionMarkerFrom(this.storage);
  }

  private async loadAccountDeletionMarkerFrom(
    storage: StorageReader,
  ): Promise<AccountDeletionMarker | undefined> {
    const marker = await storage.get<unknown>(ACCOUNT_DELETION_KEY);
    return normalizeAccountDeletionMarker(marker);
  }

  private async loadMutationWindowFrom(
    storage: StorageReader,
    now: number,
    reservationWindowStart: number | undefined,
  ): Promise<{ window: WindowState; appliesToStoredReservation: boolean }> {
    const stored = await storage.get<WindowState>("window");
    if (reservationWindowStart === undefined) {
      return { window: rollWindow(stored, now), appliesToStoredReservation: true };
    }
    if (stored?.windowStart === reservationWindowStart) {
      return {
        window: pruneExpiredReservations(stored, now),
        appliesToStoredReservation: true,
      };
    }
    return { window: rollWindow(stored, now), appliesToStoredReservation: false };
  }

  private async loadPendingSettlements(): Promise<PendingSettlement[]> {
    const pendingByKey = await this.storage.list<PendingSettlement>({
      prefix: PENDING_SETTLEMENT_KEY_PREFIX,
    });
    const pendingById = new Map<string, PendingSettlement>();
    for (const item of pendingByKey.values()) {
      if (isPendingSettlement(item)) {
        pendingById.set(item.reservationId, item);
      }
    }

    const legacyPending = await this.storage.get<PendingSettlement[]>(
      LEGACY_PENDING_SETTLEMENTS_KEY,
    );
    if (Array.isArray(legacyPending)) {
      for (const item of legacyPending) {
        if (!isPendingSettlement(item) || pendingById.has(item.reservationId)) continue;
        pendingById.set(item.reservationId, item);
        await this.storage.put(pendingSettlementKey(item.reservationId), item);
      }
      await this.storage.delete(LEGACY_PENDING_SETTLEMENTS_KEY);
    }

    return [...pendingById.values()];
  }

  private async putPendingSettlement(
    storage: StorageWriter,
    item: PendingSettlement,
  ): Promise<void> {
    const key = pendingSettlementKey(item.reservationId);
    const existing = await storage.get<PendingSettlement>(key);
    const next = isPendingSettlement(existing)
      ? {
          ...item,
          attempts: existing.attempts,
          createdAt: existing.createdAt,
          nextAttemptAt: Math.min(existing.nextAttemptAt, item.nextAttemptAt),
        }
      : item;
    await storage.put(key, next);
  }

  private async schedulePendingSettlementAlarm(): Promise<void> {
    const pending = await this.loadPendingSettlements();
    if (pending.length === 0) {
      await this.storage.deleteAlarm();
      return;
    }
    const nextAttemptAt = Math.min(...pending.map((p) => p.nextAttemptAt));
    await this.storage.setAlarm(new Date(Math.max(Date.now() + 1, nextAttemptAt)));
  }

  private async processPendingSettlements(now: number): Promise<void> {
    const pending = await this.loadPendingSettlements();

    for (const item of pending) {
      if (item.nextAttemptAt > now) {
        continue;
      }

      try {
        await this.applySettlement({
          now,
          reservationId: item.reservationId,
          reservationWindowStart: item.reservationWindowStart,
          estimatedTokens: item.estimatedTokens,
          tokensDelta: item.tokensDelta,
        });
      } catch (err) {
        if (err instanceof AccountDeletionBlockedError) {
          return;
        }
        const attempts = item.attempts + 1;
        await this.storage.put(pendingSettlementKey(item.reservationId), {
          ...item,
          attempts,
          nextAttemptAt: now + settlementRetryDelayMs(attempts),
        });
        continue;
      }

      await this.storage.delete(pendingSettlementKey(item.reservationId)).catch(() => undefined);
    }

    await this.maybePruneSettledSettlementMarkers(now).catch(() => undefined);
    await this.schedulePendingSettlementAlarm();
  }

  private async maybePruneSettledSettlementMarkers(now: number): Promise<void> {
    const nextPruneAt = await this.storage.get<number>(SETTLED_MARKER_PRUNE_AT_KEY);
    if (typeof nextPruneAt === "number" && nextPruneAt > now) return;

    const pendingIds = new Set(
      (await this.loadPendingSettlements()).map((item) => item.reservationId),
    );
    const markers = await this.storage.list<SettledSettlementMarker>({
      prefix: SETTLED_SETTLEMENT_KEY_PREFIX,
    });
    const expiredKeys: string[] = [];
    for (const [key, marker] of markers) {
      const reservationId = key.slice(SETTLED_SETTLEMENT_KEY_PREFIX.length);
      if (
        (!isSettledSettlementMarker(marker) ||
          marker.settledAt + SETTLEMENT_MARKER_RETENTION_MS <= now) &&
        !pendingIds.has(reservationId)
      ) {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length > 0) {
      await this.storage.delete(expiredKeys);
    }
    await this.storage.put(SETTLED_MARKER_PRUNE_AT_KEY, now + SETTLEMENT_MARKER_PRUNE_INTERVAL_MS);
  }
}

class AccountDeletionBlockedError extends Error {
  constructor(readonly marker: AccountDeletionMarker) {
    super("account deletion blocks quota operation");
    this.name = "AccountDeletionBlockedError";
  }
}

function nonNegativeInt(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function normalizedNow(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : Date.now();
}

function normalizeAccountDeletionMarker(v: unknown): AccountDeletionMarker | undefined {
  if (isAccountDeletionMarker(v)) return v;
  return undefined;
}

function isAccountDeletionMarker(v: unknown): v is AccountDeletionMarker {
  if (typeof v !== "object" || v === null) return false;
  const marker = v as Record<string, unknown>;
  return (
    (marker.status === "deleting" || marker.status === "deleted") &&
    typeof marker.updatedAt === "number"
  );
}

function accountDeletionResponse(marker: AccountDeletionMarker): Response {
  if (marker.status === "deleting") {
    return jsonError(
      409,
      "account_deletion_in_progress",
      "Account deletion is in progress. Please try again.",
    );
  }
  return jsonError(410, "account_deleted", "This account has been deleted.");
}

function normalizedId(v: string | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function isPendingSettlement(v: unknown): v is PendingSettlement {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.reservationId === "string" &&
    typeof p.reservationWindowStart === "number" &&
    typeof p.estimatedTokens === "number" &&
    typeof p.tokensDelta === "number" &&
    typeof p.attempts === "number" &&
    typeof p.createdAt === "number" &&
    typeof p.nextAttemptAt === "number"
  );
}

function pendingSettlementKey(reservationId: string): string {
  return `${PENDING_SETTLEMENT_KEY_PREFIX}${reservationId}`;
}

function settledSettlementKey(reservationId: string): string {
  return `${SETTLED_SETTLEMENT_KEY_PREFIX}${reservationId}`;
}

function isSettledSettlementMarker(v: unknown): v is SettledSettlementMarker {
  if (typeof v !== "object" || v === null) return false;
  const marker = v as Record<string, unknown>;
  return typeof marker.settledAt === "number";
}

function settlementRetryDelayMs(attempts: number): number {
  return Math.min(
    SETTLEMENT_RETRY_MAX_DELAY_MS,
    SETTLEMENT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  );
}
