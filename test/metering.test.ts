import { describe, it, expect } from "vitest";
import {
  buildQuota,
  CONSERVATIVE_MESSAGE_FRAMING_TOKENS,
  conservativeRequestTokenBound,
  costUsd,
  effectiveEnforcement,
  estimateRequestTokens,
  freshWindow,
  isCurrentWindow,
  isOverQuota,
  numFrom,
  parseEnforcement,
  parseQuotaOverride,
  pruneStamps,
  pruneExpiredReservations,
  RESERVATION_TTL_MS,
  reservedTokens,
  resolveLimits,
  rollWindow,
  windowResetsAt,
  windowStartUtc,
  wouldExceedQuota,
  type ResolvedLimits,
  type WindowState,
} from "../src/metering";
import {
  DEFAULT_MAX_TOKENS_PER_REQUEST,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_MONTHLY_DRAFT_LIMIT,
  DEFAULT_MONTHLY_TOKEN_LIMIT,
} from "../src/config";

// Calendar-month UTC window anchors. 2024 is a leap year, so Feb spans 29 days —
// exercising that resets are computed from the calendar, not a fixed constant.
const JAN = Date.parse("2024-01-01T00:00:00.000Z");
const FEB = Date.parse("2024-02-01T00:00:00.000Z");
const MAR = Date.parse("2024-03-01T00:00:00.000Z");
const DEC = Date.parse("2024-12-01T00:00:00.000Z");
const JAN_NEXT = Date.parse("2025-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("windowStartUtc", () => {
  it("returns the same instant for the 1st at midnight UTC", () => {
    expect(windowStartUtc(JAN)).toBe(JAN);
  });
  it("floors to the 1st 00:00 UTC from later in the same month", () => {
    // 2024-01-17T12:34:56Z -> 2024-01-01T00:00:00Z
    expect(windowStartUtc(Date.parse("2024-01-17T12:34:56.000Z"))).toBe(JAN);
  });
  it("keeps the last instant of the month in the same window", () => {
    // 2024-01-31T23:59:59.999Z is still January's window.
    expect(windowStartUtc(Date.parse("2024-01-31T23:59:59.999Z"))).toBe(JAN);
  });
  it("rolls to the next month at exactly the 1st 00:00", () => {
    expect(windowStartUtc(FEB)).toBe(FEB);
    expect(windowStartUtc(Date.parse("2024-02-01T00:00:00.000Z"))).toBe(FEB);
  });
  it("always lands on the 1st at midnight UTC", () => {
    for (const iso of ["2026-08-29T09:00:00Z", "2024-02-29T23:00:00Z", "2027-12-31T00:00:00Z"]) {
      const m = new Date(windowStartUtc(Date.parse(iso)));
      expect(m.getUTCDate()).toBe(1);
      expect(m.getUTCHours()).toBe(0);
      expect(m.getUTCMinutes()).toBe(0);
      expect(m.getUTCSeconds()).toBe(0);
      expect(m.getUTCMilliseconds()).toBe(0);
    }
  });
});

describe("windowResetsAt", () => {
  it("is the 1st of the following month", () => {
    expect(windowResetsAt(JAN)).toBe(FEB);
    expect(windowResetsAt(Date.parse("2024-01-17T12:00:00.000Z"))).toBe(FEB);
  });
  it("spans a leap February correctly (Feb 2024 -> Mar 1, 29 days)", () => {
    expect(windowResetsAt(FEB)).toBe(MAR);
    expect(MAR - FEB).toBe(29 * DAY_MS);
  });
  it("rolls the year over from December to January", () => {
    expect(windowResetsAt(DEC)).toBe(JAN_NEXT);
    expect(new Date(windowResetsAt(DEC)).getUTCFullYear()).toBe(2025);
  });
});

describe("isCurrentWindow", () => {
  it("is true only for the month window containing now", () => {
    const jan: WindowState = { windowStart: JAN, resetsAt: FEB, draftsUsed: 0, tokensUsed: 0 };
    expect(isCurrentWindow(jan, Date.parse("2024-01-20T00:00:00Z"))).toBe(true);
    expect(isCurrentWindow(jan, FEB)).toBe(false);
  });
  it("is false for a legacy weekly-style window (start/reset not month-aligned)", () => {
    // An old weekly record: windowStart on a Monday mid-month, resetsAt +7 days.
    const legacy: WindowState = {
      windowStart: Date.parse("2024-01-15T00:00:00Z"),
      resetsAt: Date.parse("2024-01-22T00:00:00Z"),
      draftsUsed: 5,
      tokensUsed: 5,
    };
    expect(isCurrentWindow(legacy, Date.parse("2024-01-16T00:00:00Z"))).toBe(false);
  });
});

describe("window rollover", () => {
  it("freshWindow starts on the 1st and resets on the next 1st", () => {
    const w = freshWindow(Date.parse("2024-01-17T10:00:00.000Z"));
    expect(w.windowStart).toBe(JAN);
    expect(w.resetsAt).toBe(FEB);
    expect(w.draftsUsed).toBe(0);
    expect(w.tokensUsed).toBe(0);
    expect(w.tokensReserved).toBe(0);
    expect(w.activeReservations).toEqual([]);
    expect(w.settledReservationIds).toEqual([]);
  });
  it("keeps an existing monthly window before reset", () => {
    const w: WindowState = {
      windowStart: JAN,
      resetsAt: FEB,
      draftsUsed: 4,
      tokensUsed: 9,
      tokensReserved: 0,
      activeReservations: [],
      settledReservationIds: [],
    };
    expect(rollWindow(w, Date.parse("2024-01-10T00:00:00Z"))).toEqual(w); // mid-month: unchanged
  });
  it("rolls to a fresh zeroed window at exactly the reset instant", () => {
    const w: WindowState = {
      windowStart: JAN,
      resetsAt: FEB,
      draftsUsed: 4,
      tokensUsed: 9,
    };
    const rolled = rollWindow(w, FEB);
    expect(rolled.windowStart).toBe(FEB);
    expect(rolled.resetsAt).toBe(MAR);
    expect(rolled.draftsUsed).toBe(0);
    expect(rolled.tokensUsed).toBe(0);
    expect(rolled.tokensReserved).toBe(0);
    expect(rolled.activeReservations).toEqual([]);
    expect(rolled.settledReservationIds).toEqual([]);
  });
  it("migrates a legacy weekly window into the fresh monthly window on first request", () => {
    // Stored under the old weekly scheme: windowStart on a Monday, resetsAt +7d.
    // `now` is still inside that weekly window, but it is not the month window for
    // `now`, so rollWindow rolls it forward (usage resets — acceptable pre-launch)
    // with no crash or stuck state.
    const legacy: WindowState = {
      windowStart: Date.parse("2024-01-15T00:00:00Z"),
      resetsAt: Date.parse("2024-01-22T00:00:00Z"),
      draftsUsed: 7,
      tokensUsed: 123,
    };
    const now = Date.parse("2024-01-16T09:00:00Z");
    const rolled = rollWindow(legacy, now);
    expect(rolled.windowStart).toBe(JAN);
    expect(rolled.resetsAt).toBe(FEB);
    expect(rolled.draftsUsed).toBe(0);
    expect(rolled.tokensUsed).toBe(0);
  });
  it("creates a window from null/undefined", () => {
    expect(rollWindow(null, JAN).windowStart).toBe(JAN);
    expect(rollWindow(null, JAN).resetsAt).toBe(FEB);
    expect(rollWindow(undefined, JAN).windowStart).toBe(JAN);
  });
  it("expires abandoned reservations inside the current window", () => {
    const state: WindowState = {
      windowStart: JAN,
      resetsAt: FEB,
      draftsUsed: 3,
      tokensUsed: 10,
      tokensReserved: 300,
      activeReservations: [
        { id: "expired", estimatedTokens: 100, expiresAt: JAN + RESERVATION_TTL_MS },
        { id: "active", estimatedTokens: 200, expiresAt: JAN + RESERVATION_TTL_MS + 10_000 },
      ],
      settledReservationIds: [],
    };
    const pruned = pruneExpiredReservations(state, JAN + RESERVATION_TTL_MS + 1);
    expect(pruned.draftsUsed).toBe(2);
    expect(pruned.tokensReserved).toBe(200);
    expect(pruned.activeReservations).toEqual([
      { id: "active", estimatedTokens: 200, expiresAt: JAN + RESERVATION_TTL_MS + 10_000 },
    ]);
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
  it("can compute a conservative byte-based hard-quota bound", () => {
    expect(conservativeRequestTokenBound(new TextEncoder().encode("abcd").byteLength, 100)).toBe(
      104,
    );
    expect(conservativeRequestTokenBound(new TextEncoder().encode("漢字").byteLength, 1)).toBe(7);
  });
  it("includes per-message framing in the conservative bound", () => {
    expect(conservativeRequestTokenBound(10, 100, 3)).toBe(
      110 + 3 * CONSERVATIVE_MESSAGE_FRAMING_TOKENS,
    );
  });
});

describe("numFrom / parseEnforcement", () => {
  it("coerces strings and numbers, falls back otherwise", () => {
    expect(numFrom("42", 1)).toBe(42);
    expect(numFrom(7, 1)).toBe(7);
    expect(numFrom(undefined, 5)).toBe(5);
    expect(numFrom("nope", 5)).toBe(5);
    expect(numFrom("", 5)).toBe(5); // empty var must fall back, not become 0
    expect(numFrom("  ", 5)).toBe(5);
  });
  it("parses enforcement mode with a soft default", () => {
    expect(parseEnforcement("hard")).toBe("hard");
    expect(parseEnforcement("soft")).toBe("soft");
    expect(parseEnforcement(undefined)).toBe("soft");
    expect(parseEnforcement("weird")).toBe("soft");
  });
});

describe("effectiveEnforcement (S-M2)", () => {
  it("forces hard for a trial (non-paid) account regardless of configured mode", () => {
    expect(effectiveEnforcement("soft", false)).toBe("hard");
    expect(effectiveEnforcement("hard", false)).toBe("hard");
  });
  it("honors the configured mode for a paid account", () => {
    expect(effectiveEnforcement("soft", true)).toBe("soft");
    expect(effectiveEnforcement("hard", true)).toBe("hard");
  });
});

describe("parseQuotaOverride", () => {
  it("reads valid numeric overrides and ignores junk", () => {
    expect(
      parseQuotaOverride({ monthlyDraftLimit: 250, extraDrafts: 10, extraDraftsWindowStart: JAN }),
    ).toEqual({
      monthlyDraftLimit: 250,
      extraDrafts: 10,
      extraDraftsWindowStart: JAN,
    });
    expect(parseQuotaOverride({ monthlyTokenLimit: 5_000_000 })).toEqual({
      monthlyTokenLimit: 5_000_000,
    });
  });
  it("accepts the legacy weekly keys as a fallback (pre-switch metadata)", () => {
    expect(parseQuotaOverride({ weeklyDraftLimit: 250, weeklyTokenLimit: 5_000_000 })).toEqual({
      monthlyDraftLimit: 250,
      monthlyTokenLimit: 5_000_000,
    });
    // The current key wins when both are present.
    expect(parseQuotaOverride({ monthlyDraftLimit: 30, weeklyDraftLimit: 250 })).toEqual({
      monthlyDraftLimit: 30,
    });
  });
  it("returns {} for non-objects and negative/invalid values", () => {
    expect(parseQuotaOverride(null)).toEqual({});
    expect(parseQuotaOverride("nope")).toEqual({});
    expect(
      parseQuotaOverride({ monthlyDraftLimit: -1, extraDrafts: "5", extraDraftsWindowStart: -1 }),
    ).toEqual({});
  });
});

describe("resolveLimits", () => {
  it("uses env defaults when no override", () => {
    const l = resolveLimits(
      {
        MONTHLY_DRAFT_LIMIT: "400",
        MONTHLY_TOKEN_LIMIT: "8000000",
        RATE_LIMIT_PER_MIN: "10",
        MAX_TOKENS_PER_REQUEST: "55000",
        ENFORCEMENT_MODE: "soft",
      },
      {},
    );
    expect(l).toEqual<ResolvedLimits>({
      monthlyDraftLimit: 400,
      monthlyTokenLimit: 8_000_000,
      rateLimitPerMin: 10,
      maxTokensPerRequest: 55_000,
      enforcement: "soft",
      extraPurchased: 0,
    });
  });
  it("falls back to code defaults when vars are absent", () => {
    const l = resolveLimits({}, {});
    expect(l.monthlyDraftLimit).toBe(DEFAULT_MONTHLY_DRAFT_LIMIT);
    expect(l.monthlyTokenLimit).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
    expect(l.rateLimitPerMin).toBe(DEFAULT_RATE_LIMIT_PER_MIN);
    expect(l.maxTokensPerRequest).toBe(DEFAULT_MAX_TOKENS_PER_REQUEST);
  });
  it("adds purchased extras only for their matching monthly window", () => {
    const l = resolveLimits(
      { MONTHLY_DRAFT_LIMIT: "30" },
      { extraDrafts: 25, extraDraftsWindowStart: JAN },
      JAN,
    );
    expect(l.monthlyDraftLimit).toBe(55);
    expect(l.extraPurchased).toBe(25);
  });
  it("ignores purchased extras without a matching monthly window", () => {
    expect(resolveLimits({ MONTHLY_DRAFT_LIMIT: "30" }, { extraDrafts: 25 }, JAN)).toMatchObject({
      monthlyDraftLimit: 30,
      extraPurchased: 0,
    });
    expect(
      resolveLimits(
        { MONTHLY_DRAFT_LIMIT: "30" },
        { extraDrafts: 25, extraDraftsWindowStart: JAN },
        FEB,
      ),
    ).toMatchObject({
      monthlyDraftLimit: 30,
      extraPurchased: 0,
    });
  });
  it("per-account monthlyDraftLimit override replaces the base, then extras add", () => {
    const l = resolveLimits(
      { MONTHLY_DRAFT_LIMIT: "30" },
      { monthlyDraftLimit: 500, extraDrafts: 10, extraDraftsWindowStart: JAN },
      JAN,
    );
    expect(l.monthlyDraftLimit).toBe(510);
  });
});

describe("buildQuota", () => {
  const limits: ResolvedLimits = {
    monthlyDraftLimit: 30,
    monthlyTokenLimit: 8_000_000,
    rateLimitPerMin: 10,
    maxTokensPerRequest: 55_000,
    enforcement: "soft",
    extraPurchased: 0,
  };
  it("produces the exact wire shape with remaining clamped at 0", () => {
    const state: WindowState = {
      windowStart: JAN,
      resetsAt: FEB,
      draftsUsed: 40,
      tokensUsed: 3_000,
    };
    expect(buildQuota(state, limits)).toEqual({
      unit: "drafts",
      used: 40,
      limit: 30,
      remaining: 0, // clamped, not negative
      resetsAt: new Date(FEB).toISOString(),
      tokensUsed: 3_000,
      tokenLimit: 8_000_000,
      enforcement: "soft",
      extraPurchased: 0,
    });
  });
  it("computes positive remaining normally", () => {
    const state: WindowState = {
      windowStart: JAN,
      resetsAt: FEB,
      draftsUsed: 12,
      tokensUsed: 0,
    };
    expect(buildQuota(state, limits).remaining).toBe(18);
  });
});

describe("isOverQuota", () => {
  const limits: ResolvedLimits = {
    monthlyDraftLimit: 30,
    monthlyTokenLimit: 2_000_000,
    rateLimitPerMin: 10,
    maxTokensPerRequest: 55_000,
    enforcement: "hard",
    extraPurchased: 0,
  };
  it("trips on drafts or tokens at/over the limit", () => {
    expect(
      isOverQuota({ windowStart: 0, resetsAt: 0, draftsUsed: 30, tokensUsed: 0 }, limits),
    ).toBe(true);
    expect(
      isOverQuota({ windowStart: 0, resetsAt: 0, draftsUsed: 0, tokensUsed: 2_000_000 }, limits),
    ).toBe(true);
    expect(
      isOverQuota({ windowStart: 0, resetsAt: 0, draftsUsed: 29, tokensUsed: 1 }, limits),
    ).toBe(false);
  });
});

describe("reservation quota helpers", () => {
  const limits: ResolvedLimits = {
    monthlyDraftLimit: 2,
    monthlyTokenLimit: 100,
    rateLimitPerMin: 10,
    maxTokensPerRequest: 55_000,
    enforcement: "hard",
    extraPurchased: 0,
  };

  it("counts in-flight token reservations when deciding hard admission", () => {
    const state: WindowState = {
      windowStart: JAN,
      resetsAt: FEB,
      draftsUsed: 1,
      tokensUsed: 30,
      tokensReserved: 60,
      activeReservations: [{ id: "r1", estimatedTokens: 60, expiresAt: FEB }],
    };
    expect(reservedTokens(state)).toBe(60);
    expect(wouldExceedQuota(state, limits, 1, 11)).toBe(true);
    expect(wouldExceedQuota(state, limits, 1, 10)).toBe(false);
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
