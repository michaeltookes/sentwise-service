import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import {
  RESERVATION_TTL_MS,
  WEEK_MS,
  type ResolvedLimits,
  type WindowState,
} from "../src/metering";

const MON = Date.parse("2024-01-01T00:00:00.000Z"); // a Monday
const OLD_BOUNDED_ARRAY_SIZE = 128;

interface CheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  window: WindowState;
}
interface WindowResult {
  window: WindowState;
}
interface ReserveResult {
  reserved: boolean;
  blockedByQuota: boolean;
  reservationId: string;
  estimatedTokens: number;
  window: WindowState;
}
interface PendingSettlementRecord {
  reservationId: string;
  tokensDelta: number;
}

const ACCOUNT_DELETION_KEY = "account_deletion";
const PENDING_SETTLEMENT_KEY_PREFIX = "pending_settlement:";

const hardLimits: ResolvedLimits = {
  weeklyDraftLimit: 1,
  weeklyTokenLimit: 2_000_000,
  rateLimitPerMin: 10,
  maxTokensPerRequest: 55_000,
  enforcement: "hard",
  extraPurchased: 0,
};

async function callDOResponse(userId: string, op: string, body: unknown): Promise<Response> {
  const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(userId));
  return stub.fetch(`https://account-quota.internal${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callDO<T>(userId: string, op: string, body: unknown): Promise<T> {
  const res = await callDOResponse(userId, op, body);
  return res.json<T>();
}

async function pendingSettlements(stub: DurableObjectStub): Promise<PendingSettlementRecord[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const pending = await state.storage.list<PendingSettlementRecord>({
      prefix: PENDING_SETTLEMENT_KEY_PREFIX,
    });
    return [...pending.values()];
  });
}

async function storedKeys(stub: DurableObjectStub): Promise<string[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    return [...(await state.storage.list()).keys()].sort();
  });
}

describe("AccountQuota Durable Object", () => {
  it("check returns the current weekly window (Mon 00:00 UTC start)", async () => {
    const r = await callDO<CheckResult>("do-window", "/check", { now: MON, rateLimitPerMin: 10 });
    expect(r.allowed).toBe(true);
    expect(r.window.windowStart).toBe(MON);
    expect(r.window.resetsAt).toBe(MON + WEEK_MS);
    expect(r.window.draftsUsed).toBe(0);
  });

  it("settle increments drafts and tokens within the window", async () => {
    await callDO("do-settle", "/check", { now: MON, rateLimitPerMin: 10 });
    const a = await callDO<WindowResult>("do-settle", "/settle", {
      now: MON + 1000,
      draftsDelta: 1,
      tokensDelta: 500,
    });
    expect(a.window.draftsUsed).toBe(1);
    expect(a.window.tokensUsed).toBe(500);
    const b = await callDO<WindowResult>("do-settle", "/settle", {
      now: MON + 2000,
      draftsDelta: 1,
      tokensDelta: 250,
    });
    expect(b.window.draftsUsed).toBe(2);
    expect(b.window.tokensUsed).toBe(750);
  });

  it("reserve atomically admits one hard-quota draft and blocks the next", async () => {
    const first = await callDO<ReserveResult>("do-reserve-hard", "/reserve", {
      now: MON,
      reservationId: "reserve-hard-1",
      estimatedTokens: 100,
      limits: hardLimits,
    });
    expect(first.reserved).toBe(true);
    expect(first.blockedByQuota).toBe(false);
    expect(first.reservationId).toBe("reserve-hard-1");
    expect(first.estimatedTokens).toBe(100);
    expect(first.window.draftsUsed).toBe(1);
    expect(first.window.tokensReserved).toBe(100);
    expect(first.window.activeReservations).toEqual([
      { id: "reserve-hard-1", estimatedTokens: 100, expiresAt: MON + RESERVATION_TTL_MS },
    ]);

    const second = await callDO<ReserveResult>("do-reserve-hard", "/reserve", {
      now: MON + 1,
      reservationId: "reserve-hard-2",
      estimatedTokens: 100,
      limits: hardLimits,
    });
    expect(second.reserved).toBe(false);
    expect(second.blockedByQuota).toBe(true);
    expect(second.window.draftsUsed).toBe(1);
  });

  it("reserve counts estimated tokens in hard quota admission", async () => {
    const limits: ResolvedLimits = {
      ...hardLimits,
      weeklyDraftLimit: 10,
      weeklyTokenLimit: 100,
    };
    const first = await callDO<ReserveResult>("do-reserve-tokens", "/reserve", {
      now: MON,
      reservationId: "reserve-token-1",
      estimatedTokens: 80,
      limits,
    });
    expect(first.reserved).toBe(true);
    expect(first.window.tokensReserved).toBe(80);

    const second = await callDO<ReserveResult>("do-reserve-tokens", "/reserve", {
      now: MON + 1,
      reservationId: "reserve-token-2",
      estimatedTokens: 21,
      limits,
    });
    expect(second.reserved).toBe(false);
    expect(second.blockedByQuota).toBe(true);
    expect(second.window.tokensReserved).toBe(80);
  });

  it("blocks quota operations during deletion without wiping preserved counters", async () => {
    const uid = "do-delete-barrier";
    const reserved = await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-barrier-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });

    const begin = await callDO<{ deleting: boolean; alreadyDeleted: boolean }>(
      uid,
      "/begin-delete",
      { now: MON + 1 },
    );
    expect(begin).toEqual({ deleting: true, alreadyDeleted: false });

    const blockedOps = [
      ["/check", { now: MON + 2, rateLimitPerMin: 10 }],
      [
        "/reserve",
        {
          now: MON + 2,
          reservationId: "delete-barrier-2",
          estimatedTokens: 1,
          limits: hardLimits,
        },
      ],
      [
        "/settle",
        {
          now: MON + 2,
          reservationId: reserved.reservationId,
          reservationWindowStart: reserved.window.windowStart,
          estimatedTokens: reserved.estimatedTokens,
          tokensDelta: 10,
        },
      ],
      [
        "/defer-settlement",
        {
          now: MON + 2,
          reservationId: reserved.reservationId,
          reservationWindowStart: reserved.window.windowStart,
          estimatedTokens: reserved.estimatedTokens,
          tokensDelta: 10,
        },
      ],
      [
        "/release",
        {
          now: MON + 2,
          reservationId: reserved.reservationId,
          reservationWindowStart: reserved.window.windowStart,
          estimatedTokens: reserved.estimatedTokens,
        },
      ],
      ["/peek", { now: MON + 2 }],
    ] as const;

    for (const [op, body] of blockedOps) {
      const res = await callDOResponse(uid, op, body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error.type).toBe("account_deletion_in_progress");
    }

    const cancel = await callDO<{ cancelled: boolean }>(uid, "/cancel-delete", {});
    expect(cancel.cancelled).toBe(true);

    const peek = await callDO<WindowResult>(uid, "/peek", { now: MON + 3 });
    expect(peek.window.draftsUsed).toBe(1);
    expect(peek.window.tokensUsed).toBe(0);
    expect(peek.window.activeReservations).toEqual([
      { id: "delete-barrier-1", estimatedTokens: 250, expiresAt: MON + RESERVATION_TTL_MS },
    ]);
  });

  it("final deletion wipes usage data but keeps a tombstone for stale tokens", async () => {
    const uid = "do-delete-finish";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const reserved = await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-finish-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await callDO<WindowResult & { queued: boolean }>(uid, "/defer-settlement", {
      now: MON + 1,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
      tokensDelta: 500,
    });

    await callDO(uid, "/begin-delete", { now: MON + 2 });
    const finish = await callDO<{ deleted: boolean }>(uid, "/finish-delete", { now: MON + 3 });
    expect(finish.deleted).toBe(true);
    expect(await storedKeys(stub)).toEqual([ACCOUNT_DELETION_KEY]);
    expect(await pendingSettlements(stub)).toEqual([]);

    const peek = await callDOResponse(uid, "/peek", { now: MON + WEEK_MS });
    expect(peek.status).toBe(410);
    expect(((await peek.json()) as any).error.type).toBe("account_deleted");

    const check = await callDOResponse(uid, "/check", {
      now: MON + WEEK_MS,
      rateLimitPerMin: 10,
    });
    expect(check.status).toBe(410);
    expect(((await check.json()) as any).error.type).toBe("account_deleted");
    expect(await storedKeys(stub)).toEqual([ACCOUNT_DELETION_KEY]);
  });

  it("alarm retries final deletion cleanup from a persisted tombstone", async () => {
    const uid = "do-delete-finish-alarm";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-finish-alarm-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, { status: "deleted", updatedAt: MON + 2 });
    });
    expect(await storedKeys(stub)).toContain("window");

    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    expect(await storedKeys(stub)).toEqual([ACCOUNT_DELETION_KEY]);
    expect(await pendingSettlements(stub)).toEqual([]);
    const peek = await callDOResponse(uid, "/peek", { now: MON + 3 });
    expect(peek.status).toBe(410);
    expect(((await peek.json()) as any).error.type).toBe("account_deleted");
  });

  it("alarm recovers a stale in-progress deletion barrier without wiping counters", async () => {
    const uid = "do-delete-stale-barrier";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-stale-barrier-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: MON,
        recoverAt: 1,
      });
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    const peek = await callDO<WindowResult>(uid, "/peek", { now: MON + 1 });
    expect(peek.window.draftsUsed).toBe(1);
    expect(peek.window.tokensReserved).toBe(250);
    expect(await storedKeys(stub)).not.toContain(ACCOUNT_DELETION_KEY);
  });

  it("release rolls back only the reserved draft in the same window", async () => {
    const reserved = await callDO<ReserveResult>("do-release", "/reserve", {
      now: MON,
      reservationId: "release-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    const released = await callDO<WindowResult>("do-release", "/release", {
      now: MON + 1,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
    });
    expect(released.window.draftsUsed).toBe(0);
    expect(released.window.tokensReserved).toBe(0);
    expect(released.window.activeReservations).toEqual([]);
  });

  it("release is idempotent when retried for the same reservation id", async () => {
    const reserved = await callDO<ReserveResult>("do-release-idempotent", "/reserve", {
      now: MON,
      reservationId: "release-idempotent-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    const body = {
      now: MON + 1,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
    };
    await callDO<WindowResult>("do-release-idempotent", "/release", body);
    const second = await callDO<WindowResult>("do-release-idempotent", "/release", body);
    expect(second.window.draftsUsed).toBe(0);
    expect(second.window.tokensReserved).toBe(0);
  });

  it("settle applies token usage to the reserved window without adding another draft", async () => {
    const reserved = await callDO<ReserveResult>("do-settle-reserved", "/reserve", {
      now: MON,
      reservationId: "settle-reserved-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    const settled = await callDO<WindowResult>("do-settle-reserved", "/settle", {
      now: MON + 1000,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
      tokensDelta: 500,
    });
    expect(settled.window.draftsUsed).toBe(1);
    expect(settled.window.tokensUsed).toBe(500);
    expect(settled.window.tokensReserved).toBe(0);
    expect(settled.window.activeReservations).toEqual([]);
  });

  it("settle ignores duplicate retries for the same reservation id", async () => {
    const reserved = await callDO<ReserveResult>("do-settle-idempotent", "/reserve", {
      now: MON,
      reservationId: "settle-idempotent-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    const body = {
      now: MON + 1000,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
      tokensDelta: 500,
    };
    const first = await callDO<WindowResult>("do-settle-idempotent", "/settle", body);
    const second = await callDO<WindowResult>("do-settle-idempotent", "/settle", {
      ...body,
      now: MON + 2000,
    });
    expect(first.window.tokensUsed).toBe(500);
    expect(second.window.tokensUsed).toBe(500);
    expect(second.window.tokensReserved).toBe(0);
  });

  it("deferred settlement is retried by a Durable Object alarm", async () => {
    const uid = "do-settle-deferred";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const callStub = async <T>(op: string, body: unknown): Promise<T> => {
      const res = await stub.fetch(`https://account-quota.internal${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.json<T>();
    };

    const reserved = await callStub<ReserveResult>("/reserve", {
      now: MON,
      reservationId: "settle-deferred-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    const deferred = await callStub<WindowResult & { queued: boolean }>("/defer-settlement", {
      now: MON + 1000,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
      tokensDelta: 500,
    });
    expect(deferred.queued).toBe(true);
    expect(deferred.window.tokensUsed).toBe(0);

    const queued = await pendingSettlements(stub);
    expect(queued).toEqual([
      expect.objectContaining({
        reservationId: "settle-deferred-1",
        tokensDelta: 500,
      }),
    ]);
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });
    const settled = await callStub<WindowResult>("/peek", { now: MON + 2000 });
    expect(settled.window.draftsUsed).toBe(1);
    expect(settled.window.tokensUsed).toBe(500);
    expect(settled.window.tokensReserved).toBe(0);
    expect(settled.window.activeReservations).toEqual([]);
    expect(settled.window.settledReservationIds).toEqual([]);
    expect(await pendingSettlements(stub)).toEqual([]);
  });

  it("preserves every deferred settlement beyond the old bounded array size", async () => {
    const uid = "do-settle-deferred-many";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const callStub = async <T>(op: string, body: unknown): Promise<T> => {
      const res = await stub.fetch(`https://account-quota.internal${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.json<T>();
    };
    const count = OLD_BOUNDED_ARRAY_SIZE + 5;
    const baseNow = Date.now() + 60_000;
    const limits: ResolvedLimits = {
      ...hardLimits,
      weeklyDraftLimit: count + 1,
      weeklyTokenLimit: count + 1,
    };

    for (let i = 0; i < count; i++) {
      const reserved = await callStub<ReserveResult>("/reserve", {
        now: baseNow + i,
        reservationId: `settle-deferred-many-${i}`,
        estimatedTokens: 1,
        limits,
      });
      await callStub<WindowResult & { queued: boolean }>("/defer-settlement", {
        now: baseNow + 1000 + i,
        reservationId: reserved.reservationId,
        reservationWindowStart: reserved.window.windowStart,
        estimatedTokens: reserved.estimatedTokens,
        tokensDelta: 1,
      });
    }

    const queuedIds = (await pendingSettlements(stub)).map((item) => item.reservationId).sort();
    expect(queuedIds).toHaveLength(count);
    expect(queuedIds).toContain("settle-deferred-many-0");
    expect(queuedIds).toContain(`settle-deferred-many-${count - 1}`);
  });

  it("settle markers dedupe older retries after many newer settlements", async () => {
    const uid = "do-settle-marker-dedupe";
    let last!: WindowResult;
    const count = OLD_BOUNDED_ARRAY_SIZE + 5;
    for (let i = 0; i < count; i++) {
      const reserved = await callDO<ReserveResult>(uid, "/reserve", {
        now: MON + i,
        reservationId: `settled-${i}`,
        estimatedTokens: 1,
        limits: { ...hardLimits, weeklyDraftLimit: 1_000, weeklyTokenLimit: 1_000 },
      });
      last = await callDO<WindowResult>(uid, "/settle", {
        now: MON + i,
        reservationId: reserved.reservationId,
        reservationWindowStart: reserved.window.windowStart,
        estimatedTokens: reserved.estimatedTokens,
        tokensDelta: 1,
      });
    }
    expect(last.window.draftsUsed).toBe(count);
    expect(last.window.tokensUsed).toBe(count);

    const retryOldSettlement = await callDO<WindowResult>(uid, "/settle", {
      now: MON + 10_000,
      reservationId: "settled-0",
      reservationWindowStart: MON,
      estimatedTokens: 1,
      tokensDelta: 1,
    });
    expect(retryOldSettlement.window.draftsUsed).toBe(count);
    expect(retryOldSettlement.window.tokensUsed).toBe(count);
  });

  it("settle still honors legacy settledReservationIds while migrating old windows", async () => {
    const uid = "do-settle-legacy-dedupe";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("window", {
        windowStart: MON,
        resetsAt: MON + WEEK_MS,
        draftsUsed: 1,
        tokensUsed: 500,
        tokensReserved: 0,
        activeReservations: [],
        settledReservationIds: ["legacy-settled-1"],
      } satisfies WindowState);
    });

    const retryLegacy = await callDO<WindowResult>(uid, "/settle", {
      now: MON + 10_000,
      reservationId: "legacy-settled-1",
      reservationWindowStart: MON,
      estimatedTokens: 1,
      tokensDelta: 500,
    });
    expect(retryLegacy.window.draftsUsed).toBe(1);
    expect(retryLegacy.window.tokensUsed).toBe(500);
  });

  it("expires abandoned reservations before admitting more hard quota capacity", async () => {
    const limits: ResolvedLimits = {
      ...hardLimits,
      weeklyDraftLimit: 1,
      weeklyTokenLimit: 500,
    };
    const first = await callDO<ReserveResult>("do-expire-reservation", "/reserve", {
      now: MON,
      reservationId: "expire-1",
      estimatedTokens: 400,
      limits,
    });
    expect(first.reserved).toBe(true);

    const second = await callDO<ReserveResult>("do-expire-reservation", "/reserve", {
      now: MON + RESERVATION_TTL_MS + 1,
      reservationId: "expire-2",
      estimatedTokens: 400,
      limits,
    });
    expect(second.reserved).toBe(true);
    expect(second.window.draftsUsed).toBe(1);
    expect(second.window.tokensReserved).toBe(400);
    expect(second.window.activeReservations).toEqual([
      {
        id: "expire-2",
        estimatedTokens: 400,
        expiresAt: MON + RESERVATION_TTL_MS + 1 + RESERVATION_TTL_MS,
      },
    ]);
  });

  it("rolls the window to a fresh, zeroed one at the next Monday", async () => {
    await callDO("do-roll", "/settle", { now: MON + 1000, draftsDelta: 5, tokensDelta: 9999 });
    // Peek exactly at the reset instant -> new window, counters reset.
    const r = await callDO<WindowResult>("do-roll", "/peek", { now: MON + WEEK_MS });
    expect(r.window.windowStart).toBe(MON + WEEK_MS);
    expect(r.window.draftsUsed).toBe(0);
    expect(r.window.tokensUsed).toBe(0);
  });

  it("peek does not rate-limit or increment", async () => {
    const first = await callDO<WindowResult>("do-peek", "/peek", { now: MON });
    const second = await callDO<WindowResult>("do-peek", "/peek", { now: MON + 100 });
    expect(first.window.draftsUsed).toBe(0);
    expect(second.window.draftsUsed).toBe(0);
  });

  it("rate limiter allows up to the limit, denies over, then recovers after 60s", async () => {
    const uid = "do-rate";
    const now = MON + 10_000;
    // 3 requests at the same instant, limit 3 -> all allowed.
    for (let i = 0; i < 3; i++) {
      const r = await callDO<CheckResult>(uid, "/check", { now, rateLimitPerMin: 3 });
      expect(r.allowed).toBe(true);
    }
    // 4th within the same minute -> denied with a positive Retry-After.
    const denied = await callDO<CheckResult>(uid, "/check", { now, rateLimitPerMin: 3 });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);

    // After the sliding 60s window fully passes, the account recovers.
    const recovered = await callDO<CheckResult>(uid, "/check", {
      now: now + 60_001,
      rateLimitPerMin: 3,
    });
    expect(recovered.allowed).toBe(true);
  });
});
