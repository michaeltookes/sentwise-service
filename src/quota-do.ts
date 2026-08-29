// AccountQuota Durable Object (56b). One instance per Clerk userId
// (`idFromName(userId)`). Stores ONLY counters, timestamps, and random
// reservation IDs for settlement dedupe — never prompts, never draft content,
// never emails.
//
// Storage keys:
//   "window" -> WindowState  (weekly usage, in-flight token reservations, reset timestamps)
//   "rate"   -> number[]     (recent request timestamps, sliding 60s window)
//   "pending_settlements" -> PendingSettlement[] (alarm-retried settlement metadata)
//
// The Worker calls these ops over the DO's internal fetch (see quota-client.ts):
//   POST /check   { now, rateLimitPerMin } -> { allowed, retryAfterSeconds, window }
//   POST /reserve { now, reservationId, estimatedTokens, limits } -> { reserved, ... }
//   POST /settle  { now, reservationId, reservationWindowStart, estimatedTokens, tokensDelta }
//   POST /defer-settlement { now, reservationId, reservationWindowStart, estimatedTokens, tokensDelta }
//   POST /release { now, reservationId, reservationWindowStart, estimatedTokens } -> { window }
//   POST /peek    { now } -> { window }   (read + roll only; no rate-limit, no increment)

import type { Env } from "./config";
import {
  activeReservations,
  MAX_SETTLED_RESERVATION_IDS,
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
interface PendingSettlement {
  reservationId: string;
  reservationWindowStart: number;
  estimatedTokens: number;
  tokensDelta: number;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
}

const PENDING_SETTLEMENTS_KEY = "pending_settlements";
const MAX_PENDING_SETTLEMENTS = 128;
const SETTLEMENT_RETRY_BASE_DELAY_MS = 60_000;
const SETTLEMENT_RETRY_MAX_DELAY_MS = 15 * 60_000;

export class AccountQuota {
  private readonly storage: DurableObjectStorage;

  constructor(state: DurableObjectState, _env: Env) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
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
    await this.processPendingSettlements(Date.now());
  }

  private async loadWindow(now: number): Promise<WindowState> {
    const stored = await this.storage.get<WindowState>("window");
    return rollWindow(stored, now);
  }

  private async handleCheck(body: CheckBody): Promise<Response> {
    const window = await this.loadWindow(body.now);

    let stamps = pruneStamps((await this.storage.get<number[]>("rate")) ?? [], body.now);
    let allowed = true;
    let retryAfterSeconds = 0;
    if (stamps.length >= body.rateLimitPerMin) {
      allowed = false;
      const oldest = stamps[0];
      retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - body.now) / 1000));
    } else {
      stamps = [...stamps, body.now];
    }

    await this.storage.put("window", window);
    await this.storage.put("rate", stamps);
    return Response.json({ allowed, retryAfterSeconds, window });
  }

  private async handleReserve(body: ReserveBody): Promise<Response> {
    const window = await this.loadWindow(body.now);
    const estimatedTokens = nonNegativeInt(body.estimatedTokens);
    if (
      body.limits.enforcement === "hard" &&
      wouldExceedQuota(window, body.limits, 1, estimatedTokens)
    ) {
      await this.storage.put("window", window);
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
    await this.storage.put("window", window);
    return Response.json({
      reserved: true,
      blockedByQuota: false,
      reservationId: body.reservationId,
      estimatedTokens,
      window,
    });
  }

  private async handleSettle(body: SettleBody): Promise<Response> {
    const window = await this.applySettlement(body);
    return Response.json({ window });
  }

  private async handleDeferSettlement(body: SettleBody): Promise<Response> {
    if (!body.reservationId || body.reservationWindowStart === undefined) {
      return new Response("reservation id and window required", { status: 400 });
    }
    const pending = upsertPendingSettlement(await this.loadPendingSettlements(), {
      reservationId: body.reservationId,
      reservationWindowStart: nonNegativeInt(body.reservationWindowStart),
      estimatedTokens: nonNegativeInt(body.estimatedTokens),
      tokensDelta: nonNegativeInt(body.tokensDelta),
      attempts: 0,
      createdAt: body.now,
      nextAttemptAt: Math.max(Date.now() + 1, body.now),
    });
    await this.savePendingSettlements(pending);
    return Response.json({ window: await this.loadWindow(body.now), queued: true });
  }

  private async applySettlement(body: SettleBody): Promise<WindowState> {
    const { window, appliesToStoredReservation } = await this.loadMutationWindow(
      body.now,
      body.reservationWindowStart,
    );
    if (appliesToStoredReservation) {
      const settledIds = window.settledReservationIds ?? [];
      if (!body.reservationId || !settledIds.includes(body.reservationId)) {
        const active = activeReservations(window);
        const reservation = active.find((r) => r.id === body.reservationId);
        const estimatedTokens =
          reservation?.estimatedTokens ?? nonNegativeInt(body.estimatedTokens);
        const draftsDelta = body.draftsDelta ?? (body.reservationId && !reservation ? 1 : 0);
        window.draftsUsed = Math.max(0, window.draftsUsed + draftsDelta);
        window.tokensReserved = Math.max(0, reservedTokens(window) - estimatedTokens);
        window.tokensUsed = Math.max(0, window.tokensUsed + body.tokensDelta);
        if (body.reservationId) {
          window.activeReservations = active.filter((r) => r.id !== body.reservationId);
        }
        if (body.reservationId) {
          window.settledReservationIds = appendSettledReservationId(settledIds, body.reservationId);
        }
      }
    }
    await this.storage.put("window", window);
    return window;
  }

  private async handleRelease(body: ReleaseBody): Promise<Response> {
    const { window, appliesToStoredReservation } = await this.loadMutationWindow(
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
    await this.storage.put("window", window);
    return Response.json({ window });
  }

  private async handlePeek(body: PeekBody): Promise<Response> {
    const window = await this.loadWindow(body.now);
    await this.storage.put("window", window);
    return Response.json({ window });
  }

  private async loadMutationWindow(
    now: number,
    reservationWindowStart: number | undefined,
  ): Promise<{ window: WindowState; appliesToStoredReservation: boolean }> {
    const stored = await this.storage.get<WindowState>("window");
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
    const pending = await this.storage.get<PendingSettlement[]>(PENDING_SETTLEMENTS_KEY);
    return Array.isArray(pending) ? pending.filter(isPendingSettlement) : [];
  }

  private async savePendingSettlements(pending: PendingSettlement[]): Promise<void> {
    if (pending.length === 0) {
      await this.storage.delete(PENDING_SETTLEMENTS_KEY);
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.put(PENDING_SETTLEMENTS_KEY, pending);
    await this.storage.setAlarm(new Date(Math.min(...pending.map((p) => p.nextAttemptAt))));
  }

  private async processPendingSettlements(now: number): Promise<void> {
    const pending = await this.loadPendingSettlements();
    const remaining: PendingSettlement[] = [];

    for (const item of pending) {
      if (item.nextAttemptAt > now) {
        remaining.push(item);
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
      } catch {
        const attempts = item.attempts + 1;
        remaining.push({
          ...item,
          attempts,
          nextAttemptAt: now + settlementRetryDelayMs(attempts),
        });
      }
    }

    await this.savePendingSettlements(remaining);
  }
}

function nonNegativeInt(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function appendSettledReservationId(ids: string[], id: string): string[] {
  return [...ids, id].slice(-MAX_SETTLED_RESERVATION_IDS);
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

function upsertPendingSettlement(
  pending: PendingSettlement[],
  item: PendingSettlement,
): PendingSettlement[] {
  const existing = pending.find((p) => p.reservationId === item.reservationId);
  const next = existing
    ? {
        ...item,
        attempts: existing.attempts,
        createdAt: existing.createdAt,
        nextAttemptAt: Math.min(existing.nextAttemptAt, item.nextAttemptAt),
      }
    : item;
  return [...pending.filter((p) => p.reservationId !== item.reservationId), next].slice(
    -MAX_PENDING_SETTLEMENTS,
  );
}

function settlementRetryDelayMs(attempts: number): number {
  return Math.min(
    SETTLEMENT_RETRY_MAX_DELAY_MS,
    SETTLEMENT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  );
}
