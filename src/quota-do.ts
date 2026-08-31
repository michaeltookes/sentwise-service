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
//   "account_deletion" -> deletion barrier/tombstone plus retry metadata
//
// The Worker calls these ops over the DO's internal fetch (see quota-client.ts):
//   POST /check   { now, rateLimitPerMin } -> { allowed, retryAfterSeconds, window }
//   POST /reserve { now, reservationId, estimatedTokens, limits } -> { reserved, ... }
//   POST /settle  { now, reservationId, reservationWindowStart, estimatedTokens, tokensDelta }
//   POST /interest { topic } -> serialize Clerk interest metadata writes per user
//   POST /defer-settlement { now, reservationId, reservationWindowStart, estimatedTokens, tokensDelta }
//   POST /release { now, reservationId, reservationWindowStart, estimatedTokens } -> { window }
//   POST /defer-release { now, reservationId, reservationWindowStart, estimatedTokens }
//   POST /peek    { now } -> { window }   (read + roll only; no rate-limit, no increment)
//   POST /begin-delete  { now, attemptId } -> block future quota reads/mutations
//   POST /cancel-delete { now, attemptId } -> drop one failed deletion attempt from the barrier
//   POST /finish-delete { now, attemptId } -> wipe counters and keep a deleted tombstone
//   POST /wipe    {} -> compatibility alias for /finish-delete

import { ACCOUNT_DELETION_BARRIER_TIMEOUT_MS, type Env } from "./config";
import { clerkUserExists, deleteClerkUser } from "./auth";
import { ApiError, jsonError } from "./errors";
import { parseInterestTopic, recordInterestInClerk } from "./interest";
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
  attemptId?: string;
}
interface PendingSettlement {
  kind?: "settle" | "release";
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
interface AccountDeletionAttempt {
  id: string;
  expiresAt: number;
}
interface AccountDeletionMarker {
  status: "deleting" | "deleted";
  updatedAt: number;
  attemptIds?: string[];
  attempts?: AccountDeletionAttempt[];
}
interface StorageReader {
  get<T = unknown>(key: string): Promise<T | undefined>;
}
interface StorageWriter extends StorageReader {
  put<T = unknown>(key: string, value: T): Promise<void>;
}
interface AlarmScheduler {
  setAlarm(scheduledTime: number | Date): Promise<void>;
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
const ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS = 60_000;
const LEGACY_DELETION_ATTEMPT_ID = "legacy-deletion-attempt";
const STORAGE_BULK_OPERATION_LIMIT = 128;

export class AccountQuota {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private readonly userId?: string;
  private interestWriteQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.storage = state.storage;
    this.env = env;
    this.userId = state.id?.name;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    switch (pathname) {
      case "/begin-delete":
        return this.handleBeginDelete(await request.json<DeletionBody>());
      case "/cancel-delete":
        return this.handleCancelDelete(await request.json<DeletionBody>());
      case "/finish-delete":
        return this.handleFinishDelete(await request.json<DeletionBody>());
      case "/defer-settlement":
        return this.handleDeferSettlement(await request.json<SettleBody>());
      case "/defer-release":
        return this.handleDeferRelease(await request.json<ReleaseBody>());
      case "/wipe":
        return this.handleWipe();
    }

    const deletion = await this.loadBlockingAccountDeletionMarker(Date.now());
    if (deletion) {
      return accountDeletionResponse(deletion);
    }

    return this.fetchWithoutDeletionPreflight(pathname, request);
  }

  private async fetchWithoutDeletionPreflight(
    pathname: string,
    request: Request,
  ): Promise<Response> {
    switch (pathname) {
      case "/check":
        return this.handleCheck(await request.json<CheckBody>());
      case "/reserve":
        return this.handleReserve(await request.json<ReserveBody>());
      case "/settle":
        return this.handleSettle(await request.json<SettleBody>());
      case "/release":
        return this.handleRelease(await request.json<ReleaseBody>());
      case "/peek":
        return this.handlePeek(await request.json<PeekBody>());
      case "/interest":
        return this.handleInterest(await request.json<unknown>());
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const deletion = await this.loadAccountDeletionMarker();
    if (deletion) {
      await this.processAccountDeletionAlarm(deletion, now);
      return;
    }
    await this.processPendingSettlements(now);
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
      if (deletion?.status === "deleted") {
        return { queued: false, deletion };
      }

      await this.putPendingSettlement(txn, {
        kind: "settle",
        reservationId: body.reservationId!,
        reservationWindowStart: nonNegativeInt(body.reservationWindowStart),
        estimatedTokens: nonNegativeInt(body.estimatedTokens),
        tokensDelta: nonNegativeInt(body.tokensDelta),
        attempts: 0,
        createdAt: body.now,
        nextAttemptAt: body.now,
      });
      if (deletion?.status === "deleting") {
        return { queued: true, deletion };
      }
      return {
        queued: true,
        window: await this.loadWindowFrom(txn, body.now),
      };
    });
    if (result.queued) {
      await this.schedulePendingSettlementAlarm();
    }
    if (result.deletion) return accountDeletionResponse(result.deletion);
    return Response.json({ window: result.window, queued: true });
  }

  private async handleDeferRelease(body: ReleaseBody): Promise<Response> {
    if (!body.reservationId || body.reservationWindowStart === undefined) {
      return new Response("reservation id and window required", { status: 400 });
    }
    const reservationId = body.reservationId;
    const result = await this.storage.transaction(async (txn) => {
      const deletion = await this.loadAccountDeletionMarkerFrom(txn);
      if (deletion?.status === "deleted") {
        return { queued: false, deletion };
      }

      await this.putPendingSettlement(txn, {
        kind: "release",
        reservationId,
        reservationWindowStart: nonNegativeInt(body.reservationWindowStart),
        estimatedTokens: nonNegativeInt(body.estimatedTokens),
        tokensDelta: 0,
        attempts: 0,
        createdAt: body.now,
        nextAttemptAt: body.now,
      });
      if (deletion?.status === "deleting") {
        return { queued: true, deletion };
      }
      return {
        queued: true,
        window: await this.loadWindowFrom(txn, body.now),
      };
    });
    if (result.queued) {
      await this.schedulePendingSettlementAlarm();
    }
    if (result.deletion) return accountDeletionResponse(result.deletion);
    return Response.json({ window: result.window, queued: true });
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
    let window: WindowState;
    try {
      window = await this.applyRelease(body);
    } catch (err) {
      if (err instanceof AccountDeletionBlockedError) {
        return accountDeletionResponse(err.marker);
      }
      throw err;
    }
    return Response.json({ window });
  }

  private async applyRelease(body: ReleaseBody): Promise<WindowState> {
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
      return window;
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

  private async handleInterest(body: unknown): Promise<Response> {
    try {
      const topic = parseInterestTopic(body);
      const userId = this.requireUserId();
      const result = await this.enqueueInterestWrite(() =>
        recordInterestInClerk(userId, topic, this.env),
      );
      return Response.json(result);
    } catch (err) {
      if (err instanceof ApiError) return err.toResponse();
      throw err;
    }
  }

  private enqueueInterestWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.interestWriteQueue.catch(() => undefined).then(operation);
    this.interestWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireUserId(): string {
    if (this.userId) return this.userId;
    throw new ApiError(500, "internal_error", "Missing account context.");
  }

  // 73: account deletion is two-phase. Begin sets a barrier before Clerk deletion
  // so authenticated in-flight requests cannot mutate or recreate quota state.
  // Finish erases usage data and keeps a tiny tombstone that blocks stale tokens
  // after Clerk deletion has succeeded.
  private async handleBeginDelete(body: DeletionBody): Promise<Response> {
    const now = normalizedNow(body.now);
    const attemptId = normalizedId(body.attemptId);
    if (!attemptId) {
      return jsonError(400, "invalid_deletion_attempt", "A deletion attempt id is required.");
    }

    const result = await this.storage.transaction(async (txn) => {
      const current = await this.loadAccountDeletionMarkerFrom(txn);
      if (current?.status === "deleted") {
        return { deleting: true, alreadyDeleted: true, attemptId };
      }

      const expiresAt = now + ACCOUNT_DELETION_BARRIER_TIMEOUT_MS;
      const attempts = current?.status === "deleting" ? activeDeletionAttempts(current) : [];
      const existingAttempt = attempts.find((attempt) => attempt.id === attemptId);
      if (existingAttempt) {
        existingAttempt.expiresAt = expiresAt;
      } else {
        attempts.push({ id: attemptId, expiresAt });
      }
      const nextAttemptAt = earliestDeletionAttemptExpiry(attempts);
      await txn.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: now,
        attemptIds: attempts.map((attempt) => attempt.id),
        attempts,
      });
      await scheduleAccountDeletionAlarmOn(txn, nextAttemptAt);
      return { deleting: true, alreadyDeleted: false, attemptId, expiresAt };
    });
    return Response.json(result);
  }

  private async handleCancelDelete(body: DeletionBody): Promise<Response> {
    const now = normalizedNow(body.now);
    const attemptId = normalizedId(body.attemptId);
    if (!attemptId) {
      return jsonError(400, "invalid_deletion_attempt", "A deletion attempt id is required.");
    }

    const result = await this.storage.transaction(async (txn) => {
      const current = await this.loadAccountDeletionMarkerFrom(txn);
      if (current?.status !== "deleting") {
        return { cancelled: false, barrierActive: current !== undefined };
      }

      const attempts = activeDeletionAttempts(current);
      if (!attempts.some((attempt) => attempt.id === attemptId)) {
        return { cancelled: false, barrierActive: true };
      }

      const remainingAttempts = attempts.filter((attempt) => attempt.id !== attemptId);
      if (remainingAttempts.length > 0) {
        await txn.put(ACCOUNT_DELETION_KEY, {
          ...current,
          updatedAt: now,
          attemptIds: remainingAttempts.map((attempt) => attempt.id),
          attempts: remainingAttempts,
        });
        await scheduleAccountDeletionAlarmOn(txn, earliestDeletionAttemptExpiry(remainingAttempts));
        return { cancelled: true, barrierActive: true };
      }

      await txn.delete(ACCOUNT_DELETION_KEY);
      return { cancelled: true, barrierActive: false };
    });
    if (!result.barrierActive) {
      await this.schedulePendingSettlementAlarm();
    }
    return Response.json(result);
  }

  private async handleFinishDelete(body: DeletionBody): Promise<Response> {
    const now = normalizedNow(body.now);
    await this.storage.put(ACCOUNT_DELETION_KEY, { status: "deleted", updatedAt: now });
    await this.scheduleAccountDeletionAlarm(now + 1).catch(() => undefined);
    try {
      await this.deleteAccountDataExceptDeletionMarker(now);
      return Response.json({ deleted: true, cleanupPending: false });
    } catch {
      await this.scheduleAccountDeletionAlarm(
        Date.now() + ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS,
      ).catch(() => undefined);
      return Response.json({ deleted: true, cleanupPending: true });
    }
  }

  // Compatibility for existing internal callers: wipe now means final deletion,
  // not "reset quota and allow a fresh window".
  private async handleWipe(): Promise<Response> {
    await this.handleFinishDelete({ now: Date.now() });
    return Response.json({ wiped: true, deleted: true });
  }

  private async deleteAccountDataExceptDeletionMarker(deletedAt: number): Promise<void> {
    while (true) {
      const keys = [...(await this.storage.list()).keys()].filter(
        (key) => key !== ACCOUNT_DELETION_KEY,
      );
      if (keys.length === 0) break;
      for (let i = 0; i < keys.length; i += STORAGE_BULK_OPERATION_LIMIT) {
        await this.storage.delete(keys.slice(i, i + STORAGE_BULK_OPERATION_LIMIT));
      }
    }
    await this.storage.put(ACCOUNT_DELETION_KEY, {
      status: "deleted",
      updatedAt: deletedAt,
    });
    await this.storage.deleteAlarm();
  }

  private async processAccountDeletionAlarm(
    marker: AccountDeletionMarker,
    now: number,
  ): Promise<void> {
    if (marker.status === "deleted") {
      try {
        await this.deleteAccountDataExceptDeletionMarker(marker.updatedAt);
      } catch {
        await this.scheduleAccountDeletionAlarm(now + ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS);
      }
      return;
    }

    await this.recoverExpiredDeletingMarker(marker, now);
  }

  private async scheduleAccountDeletionAlarm(when: number): Promise<void> {
    await scheduleAccountDeletionAlarmOn(this.storage, when);
  }

  private async loadBlockingAccountDeletionMarker(
    now: number,
  ): Promise<AccountDeletionMarker | undefined> {
    const marker = await this.loadAccountDeletionMarker();
    if (marker?.status !== "deleting") return marker;
    return this.recoverExpiredDeletingMarker(marker, now);
  }

  private async recoverExpiredDeletingMarker(
    marker: AccountDeletionMarker,
    now: number,
  ): Promise<AccountDeletionMarker | undefined> {
    const attempts = activeDeletionAttempts(marker);
    const expiredAttempts = attempts.filter((attempt) => attempt.expiresAt <= now);
    if (expiredAttempts.length === 0) {
      await this.scheduleAccountDeletionAlarm(earliestDeletionAttemptExpiry(attempts)).catch(
        () => undefined,
      );
      return marker;
    }

    if (!this.userId) {
      await this.scheduleAccountDeletionAlarm(
        now + ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS,
      ).catch(() => undefined);
      return marker;
    }

    let userExists: boolean;
    try {
      userExists = await clerkUserExists(this.userId, this.env);
    } catch {
      await this.scheduleAccountDeletionAlarm(
        now + ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS,
      ).catch(() => undefined);
      return marker;
    }

    if (!userExists) return this.finishRecoveredAccountDeletion(now);

    try {
      await deleteClerkUser(this.userId, this.env);
    } catch {
      await this.scheduleAccountDeletionAlarm(
        now + ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS,
      ).catch(() => undefined);
      return this.renewExpiredDeletionBarrier(now);
    }

    return this.finishRecoveredAccountDeletion(now);
  }

  private async finishRecoveredAccountDeletion(now: number): Promise<AccountDeletionMarker> {
    const tombstone: AccountDeletionMarker = { status: "deleted", updatedAt: now };
    await this.storage.put(ACCOUNT_DELETION_KEY, tombstone);
    await this.scheduleAccountDeletionAlarm(now + 1).catch(() => undefined);
    try {
      await this.deleteAccountDataExceptDeletionMarker(now);
    } catch {
      await this.scheduleAccountDeletionAlarm(
        now + ACCOUNT_DELETION_FINALIZATION_RETRY_DELAY_MS,
      ).catch(() => undefined);
    }
    return tombstone;
  }

  private async renewExpiredDeletionBarrier(
    now: number,
  ): Promise<AccountDeletionMarker | undefined> {
    return this.storage.transaction(async (txn) => {
      const current = await this.loadAccountDeletionMarkerFrom(txn);
      if (current?.status !== "deleting") return current;

      const remainingAttempts = activeDeletionAttempts(current).flatMap((attempt) => {
        if (attempt.expiresAt > now) return [attempt];
        return [
          {
            ...attempt,
            expiresAt: now + ACCOUNT_DELETION_BARRIER_TIMEOUT_MS,
          },
        ];
      });
      const nextMarker: AccountDeletionMarker = {
        status: "deleting",
        updatedAt: now,
        attemptIds: remainingAttempts.map((attempt) => attempt.id),
        attempts: remainingAttempts,
      };
      await txn.put(ACCOUNT_DELETION_KEY, nextMarker);
      await scheduleAccountDeletionAlarmOn(txn, earliestDeletionAttemptExpiry(remainingAttempts));
      return nextMarker;
    });
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
      if (await this.loadAccountDeletionMarker()) return;
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
        if (item.kind === "release") {
          await this.applyRelease({
            now,
            reservationId: item.reservationId,
            reservationWindowStart: item.reservationWindowStart,
            estimatedTokens: item.estimatedTokens,
          });
        } else {
          await this.applySettlement({
            now,
            reservationId: item.reservationId,
            reservationWindowStart: item.reservationWindowStart,
            estimatedTokens: item.estimatedTokens,
            tokensDelta: item.tokensDelta,
          });
        }
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

function activeDeletionAttempts(marker: AccountDeletionMarker): AccountDeletionAttempt[] {
  const fallbackExpiresAt = marker.updatedAt + ACCOUNT_DELETION_BARRIER_TIMEOUT_MS;
  const attemptsById = new Map<string, AccountDeletionAttempt>();
  if (Array.isArray(marker.attempts)) {
    for (const attempt of marker.attempts) {
      if (!isAccountDeletionAttempt(attempt)) continue;
      attemptsById.set(attempt.id, { id: attempt.id, expiresAt: attempt.expiresAt });
    }
  }
  const attemptIds = Array.isArray(marker.attemptIds)
    ? marker.attemptIds.filter((id): id is string => typeof id === "string" && id !== "")
    : [];
  for (const id of attemptIds) {
    if (!attemptsById.has(id)) attemptsById.set(id, { id, expiresAt: fallbackExpiresAt });
  }
  if (attemptsById.size === 0) {
    attemptsById.set(LEGACY_DELETION_ATTEMPT_ID, {
      id: LEGACY_DELETION_ATTEMPT_ID,
      expiresAt: fallbackExpiresAt,
    });
  }
  return [...attemptsById.values()];
}

function isAccountDeletionAttempt(v: unknown): v is AccountDeletionAttempt {
  if (typeof v !== "object" || v === null) return false;
  const attempt = v as Record<string, unknown>;
  return (
    typeof attempt.id === "string" &&
    attempt.id !== "" &&
    typeof attempt.expiresAt === "number" &&
    Number.isFinite(attempt.expiresAt) &&
    attempt.expiresAt > 0
  );
}

function earliestDeletionAttemptExpiry(attempts: AccountDeletionAttempt[]): number {
  return Math.min(...attempts.map((attempt) => attempt.expiresAt));
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

async function scheduleAccountDeletionAlarmOn(
  storage: AlarmScheduler,
  when: number,
): Promise<void> {
  await storage.setAlarm(new Date(Math.max(Date.now() + 1, when)));
}

function isPendingSettlement(v: unknown): v is PendingSettlement {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    (p.kind === undefined || p.kind === "settle" || p.kind === "release") &&
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
