import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { WEEK_MS, type ResolvedLimits, type WindowState } from "../src/metering";

const MON = Date.parse("2024-01-01T00:00:00.000Z"); // a Monday

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

const hardLimits: ResolvedLimits = {
  weeklyDraftLimit: 1,
  weeklyTokenLimit: 2_000_000,
  rateLimitPerMin: 10,
  maxTokensPerRequest: 55_000,
  enforcement: "hard",
  extraPurchased: 0,
};

async function callDO<T>(userId: string, op: string, body: unknown): Promise<T> {
  const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(userId));
  const res = await stub.fetch(`https://account-quota.internal${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json<T>();
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

  it("release rolls back only the reserved draft in the same window", async () => {
    const reserved = await callDO<ReserveResult>("do-release", "/reserve", {
      now: MON,
      reservationId: "release-1",
      estimatedTokens: 250,
      limits: hardLimits,
    });
    const released = await callDO<WindowResult>("do-release", "/release", {
      now: MON + 1,
      reservationWindowStart: reserved.window.windowStart,
      estimatedTokens: reserved.estimatedTokens,
    });
    expect(released.window.draftsUsed).toBe(0);
    expect(released.window.tokensReserved).toBe(0);
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
