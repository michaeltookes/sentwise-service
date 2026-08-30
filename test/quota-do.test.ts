import { beforeEach, describe, it, expect, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import {
  RESERVATION_TTL_MS,
  WEEK_MS,
  type ResolvedLimits,
  type WindowState,
} from "../src/metering";
import { AccountQuota } from "../src/quota-do";

const clerkMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
  deleteUser: vi.fn(),
  clerkUserExists: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  verifyToken: clerkMocks.verifyToken,
  createClerkClient: () => ({
    users: {
      getUser: clerkMocks.getUser,
      updateUserMetadata: clerkMocks.updateUserMetadata,
      deleteUser: clerkMocks.deleteUser,
    },
  }),
}));

vi.mock("../src/auth", () => ({
  clerkUserExists: clerkMocks.clerkUserExists,
}));

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
  kind?: string;
  reservationId: string;
  tokensDelta: number;
}
interface TestStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T = unknown>(): Promise<Map<string, T>>;
  delete(keyOrKeys: string | string[]): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  transaction<T>(closure: (txn: TestStorage) => Promise<T>): Promise<T>;
}

const ACCOUNT_DELETION_KEY = "account_deletion";
const PENDING_SETTLEMENT_KEY_PREFIX = "pending_settlement:";

beforeEach(() => {
  clerkMocks.verifyToken.mockReset();
  clerkMocks.getUser.mockReset();
  clerkMocks.getUser.mockRejectedValue(new Error("clerk unavailable"));
  clerkMocks.updateUserMetadata.mockReset();
  clerkMocks.deleteUser.mockReset();
  clerkMocks.clerkUserExists.mockReset();
  clerkMocks.clerkUserExists.mockRejectedValue(new Error("clerk unavailable"));
});

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

async function alarmTime(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, async (_instance, state) => {
    return state.storage.getAlarm();
  });
}

function fakeStorage(values: Map<string, unknown>): TestStorage {
  return {
    get: <T = unknown>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    list: <T = unknown>() => Promise.resolve(new Map(values) as Map<string, T>),
    delete: (keyOrKeys: string | string[]) => {
      for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
        values.delete(key);
      }
      return Promise.resolve();
    },
    setAlarm: (_scheduledTime: number | Date) => Promise.resolve(),
    deleteAlarm: () => Promise.resolve(),
    transaction: async <T>(closure: (txn: ReturnType<typeof fakeStorage>) => Promise<T>) =>
      closure(fakeStorage(values)),
  };
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
      { now: MON + 1, attemptId: "delete-barrier-attempt" },
    );
    expect(begin).toMatchObject({
      deleting: true,
      alreadyDeleted: false,
      attemptId: "delete-barrier-attempt",
    });
    expect((begin as { expiresAt?: unknown }).expiresAt).toEqual(expect.any(Number));

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

    const cancel = await callDO<{ cancelled: boolean }>(uid, "/cancel-delete", {
      now: MON + 3,
      attemptId: "delete-barrier-attempt",
    });
    expect(cancel.cancelled).toBe(true);

    const peek = await callDO<WindowResult>(uid, "/peek", { now: MON + 3 });
    expect(peek.window.draftsUsed).toBe(1);
    expect(peek.window.tokensUsed).toBe(0);
    expect(peek.window.activeReservations).toEqual([
      { id: "delete-barrier-1", estimatedTokens: 250, expiresAt: MON + RESERVATION_TTL_MS },
    ]);
  });

  it("queues settlements blocked by deletion and replays them after cancellation", async () => {
    const uid = "do-delete-blocked-settlement-replay";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const baseNow = Date.now() - 10;
    const reserved = await callDO<ReserveResult>(uid, "/reserve", {
      now: baseNow,
      reservationId: "delete-blocked-settlement-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await callDO(uid, "/begin-delete", {
      now: baseNow + 1,
      attemptId: "delete-blocked-settlement-attempt",
    });

    const deferred = await callDOResponse(uid, "/defer-settlement", {
      now: baseNow + 2,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
      tokensDelta: 500,
    });

    expect(deferred.status).toBe(409);
    expect(((await deferred.json()) as any).error.type).toBe("account_deletion_in_progress");
    expect(await pendingSettlements(stub)).toHaveLength(1);

    await callDO(uid, "/cancel-delete", {
      now: baseNow + 3,
      attemptId: "delete-blocked-settlement-attempt",
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    expect(await pendingSettlements(stub)).toEqual([]);
    const peek = await callDO<WindowResult>(uid, "/peek", { now: baseNow + 4 });
    expect(peek.window.draftsUsed).toBe(1);
    expect(peek.window.tokensUsed).toBe(500);
    expect(peek.window.tokensReserved).toBe(0);
  });

  it("queues releases blocked by deletion and replays them after cancellation", async () => {
    const uid = "do-delete-blocked-release-replay";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const baseNow = Date.now() - 10;
    const reserved = await callDO<ReserveResult>(uid, "/reserve", {
      now: baseNow,
      reservationId: "delete-blocked-release-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await callDO(uid, "/begin-delete", {
      now: baseNow + 1,
      attemptId: "delete-blocked-release-attempt",
    });

    const deferred = await callDOResponse(uid, "/defer-release", {
      now: baseNow + 2,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
    });

    expect(deferred.status).toBe(409);
    expect(((await deferred.json()) as any).error.type).toBe("account_deletion_in_progress");
    expect(await pendingSettlements(stub)).toEqual([
      expect.objectContaining({
        kind: "release",
        reservationId: reserved.reservationId,
        tokensDelta: 0,
      }),
    ]);

    await callDO(uid, "/cancel-delete", {
      now: baseNow + 3,
      attemptId: "delete-blocked-release-attempt",
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    expect(await pendingSettlements(stub)).toEqual([]);
    const peek = await callDO<WindowResult>(uid, "/peek", { now: baseNow + 4 });
    expect(peek.window.draftsUsed).toBe(0);
    expect(peek.window.tokensUsed).toBe(0);
    expect(peek.window.tokensReserved).toBe(0);
    expect(peek.window.activeReservations).toEqual([]);
  });

  it("begin-delete schedules a stale-barrier recovery alarm", async () => {
    const uid = "do-delete-begin-alarm";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));

    const begin = await callDO<{ deleting: boolean; alreadyDeleted: boolean }>(
      uid,
      "/begin-delete",
      { now: Date.now(), attemptId: "delete-begin-alarm-attempt" },
    );

    expect(begin.deleting).toBe(true);
    expect(begin.alreadyDeleted).toBe(false);
    expect(await alarmTime(stub)).not.toBeNull();
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

    await callDO(uid, "/begin-delete", { now: MON + 2, attemptId: "delete-finish-attempt" });
    const finish = await callDO<{ deleted: boolean }>(uid, "/finish-delete", {
      now: MON + 3,
      attemptId: "delete-finish-attempt",
    });
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

  it("persists the deletion tombstone before scheduling cleanup retry", async () => {
    const calls: string[] = [];
    const values = new Map<string, unknown>();
    const storage = {
      get: (key: string) => Promise.resolve(values.get(key)),
      put: (key: string, value: unknown) => {
        const status =
          key === ACCOUNT_DELETION_KEY && typeof value === "object" && value !== null
            ? (value as { status?: unknown }).status
            : key;
        calls.push(`put:${String(status)}`);
        values.set(key, value);
        return Promise.resolve();
      },
      list: () => {
        calls.push("list");
        return Promise.resolve(new Map(values));
      },
      delete: (keyOrKeys: string | string[]) => {
        calls.push(`delete:${Array.isArray(keyOrKeys) ? keyOrKeys.length : keyOrKeys}`);
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
          values.delete(key);
        }
        return Promise.resolve();
      },
      setAlarm: () => {
        calls.push("setAlarm");
        return Promise.resolve();
      },
      deleteAlarm: () => {
        calls.push("deleteAlarm");
        return Promise.resolve();
      },
    };
    const quota = new AccountQuota({ storage } as unknown as DurableObjectState, {} as Env);

    const finish = await quota.fetch(
      new Request("https://account-quota.internal/finish-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: MON + 1, attemptId: "finish-order-attempt" }),
      }),
    );

    expect(finish.status).toBe(200);
    expect(calls.slice(0, 2)).toEqual(["put:deleted", "setAlarm"]);
  });

  it("final deletion wipes account data in bounded storage batches", async () => {
    const uid = "do-delete-finish-many-keys";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("window", {
        windowStart: MON,
        resetsAt: MON + WEEK_MS,
        draftsUsed: 1,
        tokensUsed: 5,
      });
      for (let i = 0; i < OLD_BOUNDED_ARRAY_SIZE + 5; i++) {
        await state.storage.put(`settled_settlement:delete-batch-${i}`, {
          settledAt: MON + i,
        });
      }
    });

    await callDO(uid, "/begin-delete", { now: MON + 1, attemptId: "delete-batch-attempt" });
    const finish = await callDO<{ deleted: boolean; cleanupPending: boolean }>(
      uid,
      "/finish-delete",
      {
        now: MON + 2,
        attemptId: "delete-batch-attempt",
      },
    );

    expect(finish).toEqual({ deleted: true, cleanupPending: false });
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

  it("cancel-delete only removes the matching deletion attempt", async () => {
    const uid = "do-delete-concurrent-cancel";
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-concurrent-cancel-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await callDO(uid, "/begin-delete", { now: MON + 1, attemptId: "attempt-a" });
    await callDO(uid, "/begin-delete", { now: MON + 2, attemptId: "attempt-b" });

    const cancelA = await callDO<{ cancelled: boolean; barrierActive: boolean }>(
      uid,
      "/cancel-delete",
      {
        now: MON + 3,
        attemptId: "attempt-a",
      },
    );
    expect(cancelA).toEqual({ cancelled: true, barrierActive: true });

    const blocked = await callDOResponse(uid, "/peek", { now: MON + 4 });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).error.type).toBe("account_deletion_in_progress");

    const cancelB = await callDO<{ cancelled: boolean; barrierActive: boolean }>(
      uid,
      "/cancel-delete",
      {
        now: MON + 5,
        attemptId: "attempt-b",
      },
    );
    expect(cancelB).toEqual({ cancelled: true, barrierActive: false });

    const peek = await callDO<WindowResult>(uid, "/peek", { now: MON + 6 });
    expect(peek.window.draftsUsed).toBe(1);
    expect(peek.window.tokensReserved).toBe(250);
  });

  it("does not cancel a legacy deletion barrier with a new failed attempt", async () => {
    const uid = "do-delete-legacy-barrier";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-legacy-barrier-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: MON,
      });
    });

    await callDO(uid, "/begin-delete", { now: MON + 1, attemptId: "new-attempt" });
    const cancel = await callDO<{ cancelled: boolean; barrierActive: boolean }>(
      uid,
      "/cancel-delete",
      {
        now: MON + 2,
        attemptId: "new-attempt",
      },
    );
    expect(cancel).toEqual({ cancelled: true, barrierActive: true });

    const blocked = await callDOResponse(uid, "/peek", { now: MON + 3 });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).error.type).toBe("account_deletion_in_progress");
  });

  it("rearms pending settlement alarms after an idempotent cancel retry", async () => {
    const uid = "do-delete-cancel-rearm-pending";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const baseNow = Date.now() + 60_000;
    const reserved = await callDO<ReserveResult>(uid, "/reserve", {
      now: baseNow,
      reservationId: "delete-cancel-rearm-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await callDO<WindowResult & { queued: boolean }>(uid, "/defer-settlement", {
      now: baseNow + 1,
      reservationId: reserved.reservationId,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
      tokensDelta: 500,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
    expect(await pendingSettlements(stub)).toHaveLength(1);
    expect(await alarmTime(stub)).toBeNull();

    const cancel = await callDO<{ cancelled: boolean; barrierActive: boolean }>(
      uid,
      "/cancel-delete",
      {
        now: baseNow + 2,
        attemptId: "already-cancelled-attempt",
      },
    );

    expect(cancel).toEqual({ cancelled: false, barrierActive: false });
    expect(await alarmTime(stub)).not.toBeNull();
  });

  it("alarm preserves an unexpired in-progress deletion barrier without wiping counters", async () => {
    const uid = "do-delete-stale-barrier";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    const expiresAt = Date.now() + 60_000;
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-stale-barrier-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: Date.now(),
        attemptIds: ["stale-attempt"],
        attempts: [{ id: "stale-attempt", expiresAt }],
      });
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    const peek = await callDOResponse(uid, "/peek", { now: MON + 1 });
    expect(peek.status).toBe(409);
    expect(((await peek.json()) as any).error.type).toBe("account_deletion_in_progress");
    expect(await storedKeys(stub)).toContain(ACCOUNT_DELETION_KEY);
    expect(clerkMocks.clerkUserExists).not.toHaveBeenCalled();
    expect(await alarmTime(stub)).not.toBeNull();
  });

  it("alarm keeps an expired deletion barrier when Clerk still has the user", async () => {
    const uid = "do-delete-expired-barrier-active-user";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-expired-barrier-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: MON,
        attemptIds: ["expired-attempt"],
        attempts: [{ id: "expired-attempt", expiresAt: MON + 1 }],
      });
    });
    clerkMocks.clerkUserExists.mockResolvedValue(true);

    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    expect(clerkMocks.clerkUserExists).toHaveBeenCalledWith(uid, expect.any(Object));
    expect(await storedKeys(stub)).toContain(ACCOUNT_DELETION_KEY);
    const blocked = await callDOResponse(uid, "/peek", { now: MON + 2 });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as any).error.type).toBe("account_deletion_in_progress");
  });

  it("stale barrier recovery preserves fresh attempts added during Clerk lookup", async () => {
    const uid = "do-delete-expired-reread-attempts";
    const values = new Map<string, unknown>([
      [
        ACCOUNT_DELETION_KEY,
        {
          status: "deleting",
          updatedAt: MON,
          attemptIds: ["expired-attempt"],
          attempts: [{ id: "expired-attempt", expiresAt: MON + 1 }],
        },
      ],
      [
        "window",
        {
          windowStart: MON,
          resetsAt: MON + WEEK_MS,
          draftsUsed: 1,
          tokensUsed: 0,
        },
      ],
    ]);
    const storage = fakeStorage(values);
    const quota = new AccountQuota(
      { id: { name: uid }, storage } as unknown as DurableObjectState,
      {} as Env,
    );
    clerkMocks.clerkUserExists.mockImplementation(() => {
      values.set(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: Date.now(),
        attemptIds: ["expired-attempt", "fresh-attempt"],
        attempts: [
          { id: "expired-attempt", expiresAt: MON + 1 },
          { id: "fresh-attempt", expiresAt: Date.now() + 60_000 },
        ],
      });
      return Promise.resolve(true);
    });

    const peek = await quota.fetch(
      new Request("https://account-quota.internal/peek", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: Date.now() }),
      }),
    );

    expect(peek.status).toBe(409);
    const marker = values.get(ACCOUNT_DELETION_KEY) as { attemptIds?: string[] };
    expect(marker.attemptIds).toEqual(["expired-attempt", "fresh-attempt"]);
  });

  it("quota requests keep an expired deletion barrier after the first positive Clerk lookup", async () => {
    const uid = "do-delete-expired-barrier-request";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-expired-request-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: MON,
        attemptIds: ["expired-attempt"],
        attempts: [{ id: "expired-attempt", expiresAt: MON + 1 }],
      });
    });
    clerkMocks.clerkUserExists.mockResolvedValue(true);

    const peek = await callDOResponse(uid, "/peek", { now: MON + 2 });

    expect(clerkMocks.clerkUserExists).toHaveBeenCalledWith(uid, expect.any(Object));
    expect(peek.status).toBe(409);
    expect(((await peek.json()) as any).error.type).toBe("account_deletion_in_progress");
    expect(await storedKeys(stub)).toContain(ACCOUNT_DELETION_KEY);
    const marker = await runInDurableObject(stub, async (_instance, state) => {
      return state.storage.get<{
        attempts?: Array<{ expiresAt?: number; liveVerifiedAt?: number }>;
      }>(ACCOUNT_DELETION_KEY);
    });
    expect(marker?.attempts?.[0]?.expiresAt).toEqual(expect.any(Number));
    expect(marker?.attempts?.[0]?.expiresAt).toBeGreaterThan(MON + 1);
    expect(marker?.attempts?.[0]).not.toHaveProperty("liveVerifiedAt");
  });

  it("keeps the deletion barrier when Clerk existence lookup fails", async () => {
    const uid = "do-delete-expired-barrier-lookup-fail";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-expired-lookup-fail-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: MON,
        attemptIds: ["expired-attempt"],
        attempts: [{ id: "expired-attempt", expiresAt: MON + 1 }],
      });
    });
    clerkMocks.clerkUserExists.mockRejectedValue(new Error("timeout"));

    const peek = await callDOResponse(uid, "/peek", { now: MON + 2 });

    expect(clerkMocks.clerkUserExists).toHaveBeenCalledWith(uid, expect.any(Object));
    expect(peek.status).toBe(409);
    expect(((await peek.json()) as any).error.type).toBe("account_deletion_in_progress");
    expect(await storedKeys(stub)).toContain(ACCOUNT_DELETION_KEY);
    expect(await alarmTime(stub)).not.toBeNull();
  });

  it("alarm finalizes an expired deletion barrier when Clerk user is gone", async () => {
    const uid = "do-delete-expired-barrier-gone-user";
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await callDO<ReserveResult>(uid, "/reserve", {
      now: MON,
      reservationId: "delete-expired-barrier-gone-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(ACCOUNT_DELETION_KEY, {
        status: "deleting",
        updatedAt: MON,
        attemptIds: ["expired-attempt"],
        attempts: [{ id: "expired-attempt", expiresAt: MON + 1 }],
      });
    });
    clerkMocks.clerkUserExists.mockResolvedValue(false);

    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    expect(clerkMocks.clerkUserExists).toHaveBeenCalledWith(uid, expect.any(Object));
    expect(await storedKeys(stub)).toEqual([ACCOUNT_DELETION_KEY]);
    const peek = await callDOResponse(uid, "/peek", { now: MON + 2 });
    expect(peek.status).toBe(410);
    expect(((await peek.json()) as any).error.type).toBe("account_deleted");
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
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(`${PENDING_SETTLEMENT_KEY_PREFIX}${reserved.reservationId}`, {
        reservationId: reserved.reservationId,
        reservationWindowStart: reserved.window.windowStart,
        estimatedTokens: reserved.estimatedTokens,
        tokensDelta: 500,
        attempts: 0,
        createdAt: MON + 1000,
        nextAttemptAt: 1,
      });
    });

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
