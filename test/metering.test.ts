import { describe, it, expect } from "vitest";
import {
  buildQuota,
  costUsd,
  estimateRequestTokens,
  freshWindow,
  isOverQuota,
  mondayStartUtc,
  numFrom,
  parseEnforcement,
  parseQuotaOverride,
  pruneStamps,
  resolveLimits,
  rollWindow,
  WEEK_MS,
  type ResolvedLimits,
  type WindowState,
} from "../src/metering";
import {
  DEFAULT_MAX_TOKENS_PER_REQUEST,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_WEEKLY_DRAFT_LIMIT,
  DEFAULT_WEEKLY_TOKEN_LIMIT,
} from "../src/config";

const MON = Date.parse("2024-01-01T00:00:00.000Z"); // 2024-01-01 was a Monday

describe("mondayStartUtc", () => {
  it("returns the same instant for a Monday midnight UTC", () => {
    expect(mondayStartUtc(MON)).toBe(MON);
  });
  it("floors to Monday 00:00 UTC from later in the same week", () => {
    // Wednesday 2024-01-03T12:34:56Z -> Monday 2024-01-01T00:00:00Z
    expect(mondayStartUtc(Date.parse("2024-01-03T12:34:56.000Z"))).toBe(MON);
  });
  it("keeps Sunday in the same (Mon-started) week", () => {
    // Sunday 2024-01-07T23:59:59Z is still the week beginning Mon Jan 1.
    expect(mondayStartUtc(Date.parse("2024-01-07T23:59:59.000Z"))).toBe(MON);
  });
  it("rolls to the next Monday at the following Monday 00:00", () => {
    expect(mondayStartUtc(Date.parse("2024-01-08T00:00:00.000Z"))).toBe(MON + WEEK_MS);
  });
  it("always lands on a UTC Monday at midnight", () => {
    for (const iso of ["2026-08-29T09:00:00Z", "2026-02-28T23:00:00Z", "2027-12-31T00:00:00Z"]) {
      const m = new Date(mondayStartUtc(Date.parse(iso)));
      expect(m.getUTCDay()).toBe(1);
      expect(m.getUTCHours()).toBe(0);
      expect(m.getUTCMinutes()).toBe(0);
      expect(m.getUTCSeconds()).toBe(0);
      expect(m.getUTCMilliseconds()).toBe(0);
    }
  });
});

describe("window rollover", () => {
  it("freshWindow starts Monday and resets a week later", () => {
    const w = freshWindow(Date.parse("2024-01-03T10:00:00.000Z"));
    expect(w.windowStart).toBe(MON);
    expect(w.resetsAt).toBe(MON + WEEK_MS);
    expect(w.draftsUsed).toBe(0);
    expect(w.tokensUsed).toBe(0);
  });
  it("keeps an existing window before reset", () => {
    const w: WindowState = {
      windowStart: MON,
      resetsAt: MON + WEEK_MS,
      draftsUsed: 4,
      tokensUsed: 9,
    };
    expect(rollWindow(w, MON + 3 * 24 * 60 * 60 * 1000)).toBe(w); // mid-week: unchanged
  });
  it("rolls to a fresh zeroed window at exactly the reset instant", () => {
    const w: WindowState = {
      windowStart: MON,
      resetsAt: MON + WEEK_MS,
      draftsUsed: 4,
      tokensUsed: 9,
    };
    const rolled = rollWindow(w, MON + WEEK_MS);
    expect(rolled.windowStart).toBe(MON + WEEK_MS);
    expect(rolled.draftsUsed).toBe(0);
    expect(rolled.tokensUsed).toBe(0);
  });
  it("creates a window from null/undefined", () => {
    expect(rollWindow(null, MON).windowStart).toBe(MON);
    expect(rollWindow(undefined, MON).windowStart).toBe(MON);
  });
});

describe("pruneStamps", () => {
  it("drops timestamps older than the 60s window", () => {
    const now = 1_000_000;
    const stamps = [now - 61_000, now - 60_000, now - 30_000, now];
    // strictly older-than-cutoff dropped; cutoff = now - 60_000 (exclusive)
    expect(pruneStamps(stamps, now)).toEqual([now - 30_000, now]);
  });
});

describe("estimateRequestTokens", () => {
  it("is ceil(chars/4) + maxTokens", () => {
    expect(estimateRequestTokens(0, 100)).toBe(100);
    expect(estimateRequestTokens(10, 100)).toBe(103); // ceil(10/4)=3
    expect(estimateRequestTokens(200_000, 4096)).toBe(54_096);
  });
});

describe("numFrom / parseEnforcement", () => {
  it("coerces strings and numbers, falls back otherwise", () => {
    expect(numFrom("42", 1)).toBe(42);
    expect(numFrom(7, 1)).toBe(7);
    expect(numFrom(undefined, 5)).toBe(5);
    expect(numFrom("nope", 5)).toBe(5);
  });
  it("parses enforcement mode with a soft default", () => {
    expect(parseEnforcement("hard")).toBe("hard");
    expect(parseEnforcement("soft")).toBe("soft");
    expect(parseEnforcement(undefined)).toBe("soft");
    expect(parseEnforcement("weird")).toBe("soft");
  });
});

describe("parseQuotaOverride", () => {
  it("reads valid numeric overrides and ignores junk", () => {
    expect(parseQuotaOverride({ weeklyDraftLimit: 250, extraDrafts: 10 })).toEqual({
      weeklyDraftLimit: 250,
      extraDrafts: 10,
    });
    expect(parseQuotaOverride({ weeklyTokenLimit: 5_000_000 })).toEqual({
      weeklyTokenLimit: 5_000_000,
    });
  });
  it("returns {} for non-objects and negative/invalid values", () => {
    expect(parseQuotaOverride(null)).toEqual({});
    expect(parseQuotaOverride("nope")).toEqual({});
    expect(parseQuotaOverride({ weeklyDraftLimit: -1, extraDrafts: "5" })).toEqual({});
  });
});

describe("resolveLimits", () => {
  it("uses env defaults when no override", () => {
    const l = resolveLimits(
      {
        WEEKLY_DRAFT_LIMIT: "100",
        WEEKLY_TOKEN_LIMIT: "2000000",
        RATE_LIMIT_PER_MIN: "10",
        MAX_TOKENS_PER_REQUEST: "55000",
        ENFORCEMENT_MODE: "soft",
      },
      {},
    );
    expect(l).toEqual<ResolvedLimits>({
      weeklyDraftLimit: 100,
      weeklyTokenLimit: 2_000_000,
      rateLimitPerMin: 10,
      maxTokensPerRequest: 55_000,
      enforcement: "soft",
      extraPurchased: 0,
    });
  });
  it("falls back to code defaults when vars are absent", () => {
    const l = resolveLimits({}, {});
    expect(l.weeklyDraftLimit).toBe(DEFAULT_WEEKLY_DRAFT_LIMIT);
    expect(l.weeklyTokenLimit).toBe(DEFAULT_WEEKLY_TOKEN_LIMIT);
    expect(l.rateLimitPerMin).toBe(DEFAULT_RATE_LIMIT_PER_MIN);
    expect(l.maxTokensPerRequest).toBe(DEFAULT_MAX_TOKENS_PER_REQUEST);
  });
  it("adds purchased extras to the draft limit and exposes extraPurchased", () => {
    const l = resolveLimits({ WEEKLY_DRAFT_LIMIT: "100" }, { extraDrafts: 25 });
    expect(l.weeklyDraftLimit).toBe(125);
    expect(l.extraPurchased).toBe(25);
  });
  it("per-account weeklyDraftLimit override replaces the base, then extras add", () => {
    const l = resolveLimits(
      { WEEKLY_DRAFT_LIMIT: "100" },
      { weeklyDraftLimit: 500, extraDrafts: 10 },
    );
    expect(l.weeklyDraftLimit).toBe(510);
  });
});

describe("buildQuota", () => {
  const limits: ResolvedLimits = {
    weeklyDraftLimit: 100,
    weeklyTokenLimit: 2_000_000,
    rateLimitPerMin: 10,
    maxTokensPerRequest: 55_000,
    enforcement: "soft",
    extraPurchased: 0,
  };
  it("produces the exact wire shape with remaining clamped at 0", () => {
    const state: WindowState = {
      windowStart: MON,
      resetsAt: MON + WEEK_MS,
      draftsUsed: 120,
      tokensUsed: 3_000,
    };
    expect(buildQuota(state, limits)).toEqual({
      unit: "drafts",
      used: 120,
      limit: 100,
      remaining: 0, // clamped, not negative
      resetsAt: new Date(MON + WEEK_MS).toISOString(),
      tokensUsed: 3_000,
      tokenLimit: 2_000_000,
      enforcement: "soft",
      extraPurchased: 0,
    });
  });
  it("computes positive remaining normally", () => {
    const state: WindowState = {
      windowStart: MON,
      resetsAt: MON + WEEK_MS,
      draftsUsed: 30,
      tokensUsed: 0,
    };
    expect(buildQuota(state, limits).remaining).toBe(70);
  });
});

describe("isOverQuota", () => {
  const limits: ResolvedLimits = {
    weeklyDraftLimit: 100,
    weeklyTokenLimit: 2_000_000,
    rateLimitPerMin: 10,
    maxTokensPerRequest: 55_000,
    enforcement: "hard",
    extraPurchased: 0,
  };
  it("trips on drafts or tokens at/over the limit", () => {
    expect(
      isOverQuota({ windowStart: 0, resetsAt: 0, draftsUsed: 100, tokensUsed: 0 }, limits),
    ).toBe(true);
    expect(
      isOverQuota({ windowStart: 0, resetsAt: 0, draftsUsed: 0, tokensUsed: 2_000_000 }, limits),
    ).toBe(true);
    expect(
      isOverQuota({ windowStart: 0, resetsAt: 0, draftsUsed: 99, tokensUsed: 1 }, limits),
    ).toBe(false);
  });
});

describe("costUsd", () => {
  it("prices Sonnet 4.6 at $3/$15 per MTok", () => {
    // 1,000,000 in + 1,000,000 out = $3 + $15 = $18
    expect(costUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
  });
  it("falls back to the default row for unknown models", () => {
    expect(costUsd("some-unknown-model", 1_000_000, 0)).toBeCloseTo(3, 6);
  });
});
