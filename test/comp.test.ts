// Pure comp-entitlement layer tests (app-repo backlog item 111).

import { describe, it, expect } from "vitest";
import {
  COMP_DEFAULT_DAYS,
  applyCompEntitlement,
  compIsActive,
  isCompPlan,
  parseCompEntitlement,
  type CompEntitlement,
} from "../src/comp";
import { hasPaidAccess, type Subscription } from "../src/subscription";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const FUTURE = "2027-01-06T12:00:00.000Z";
const PAST = "2026-09-01T00:00:00.000Z";

function comp(overrides: Partial<CompEntitlement> = {}): CompEntitlement {
  return { plan: "pro", grantedAt: "2026-10-08T00:00:00.000Z", expiresAt: FUTURE, ...overrides };
}

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return { plan: "trial", status: "lapsed", renewsAt: null, manageBillingUrl: null, ...overrides };
}

describe("isCompPlan", () => {
  it("accepts only the three sold tiers", () => {
    expect(isCompPlan("starter")).toBe(true);
    expect(isCompPlan("pro")).toBe(true);
    expect(isCompPlan("unlimited")).toBe(true);
  });

  it("rejects team (reserved), trial, none, and garbage", () => {
    expect(isCompPlan("team")).toBe(false);
    expect(isCompPlan("trial")).toBe(false);
    expect(isCompPlan("none")).toBe(false);
    expect(isCompPlan("")).toBe(false);
    expect(isCompPlan(42)).toBe(false);
  });
});

describe("parseCompEntitlement", () => {
  it("parses a valid record", () => {
    expect(parseCompEntitlement(comp())).toEqual(comp());
  });

  it("returns null for absent or non-object values", () => {
    expect(parseCompEntitlement(undefined)).toBeNull();
    expect(parseCompEntitlement(null)).toBeNull();
    expect(parseCompEntitlement("pro")).toBeNull();
  });

  it("returns null for a reserved or invalid plan", () => {
    expect(parseCompEntitlement(comp({ plan: "team" as never }))).toBeNull();
    expect(parseCompEntitlement({ ...comp(), plan: "gold" })).toBeNull();
  });

  it("returns null when expiresAt is missing or malformed (comps always expire)", () => {
    expect(parseCompEntitlement({ plan: "pro" })).toBeNull();
    expect(parseCompEntitlement(comp({ expiresAt: "not-a-date" }))).toBeNull();
    expect(parseCompEntitlement(comp({ expiresAt: "2027-01-06" }))).toBeNull();
  });

  it("drops a malformed grantedAt to null without poisoning the record", () => {
    const parsed = parseCompEntitlement({ ...comp(), grantedAt: "whenever" });
    expect(parsed).toEqual(comp({ grantedAt: null }));
  });
});

describe("compIsActive", () => {
  it("is active strictly before the expiry instant", () => {
    expect(compIsActive(comp(), Date.parse(FUTURE) - 1)).toBe(true);
    expect(compIsActive(comp(), Date.parse(FUTURE))).toBe(false);
    expect(compIsActive(comp({ expiresAt: PAST }), NOW)).toBe(false);
  });
});

describe("applyCompEntitlement", () => {
  it("presents an active comp as an active paid plan with renewsAt = expiry", () => {
    const out = applyCompEntitlement(sub(), comp(), NOW);
    expect(out.compApplied).toBe(true);
    expect(out.subscription).toEqual({
      plan: "pro",
      status: "active",
      renewsAt: FUTURE,
      manageBillingUrl: null,
    });
    // Indistinguishable from paid: the paid-access gate accepts it.
    expect(hasPaidAccess(out.subscription)).toBe(true);
  });

  it("leaves the natural state untouched without a comp", () => {
    const natural = sub();
    expect(applyCompEntitlement(natural, null, NOW)).toEqual({
      subscription: natural,
      compApplied: false,
    });
  });

  it("reverts to the natural state once the comp lapses (lazy expiry)", () => {
    const natural = sub();
    const out = applyCompEntitlement(natural, comp({ expiresAt: PAST }), NOW);
    expect(out.compApplied).toBe(false);
    expect(out.subscription).toBe(natural);
  });

  it("is inert when a real paid subscription is active (real subscription wins)", () => {
    for (const status of ["active", "trialing", "past_due"] as const) {
      const real = sub({ plan: "starter", status, renewsAt: "2026-11-01T00:00:00.000Z" });
      const out = applyCompEntitlement(real, comp({ plan: "unlimited" }), NOW);
      expect(out.compApplied).toBe(false);
      expect(out.subscription).toBe(real);
    }
  });

  it("applies over a canceled or lapsed real subscription", () => {
    for (const status of ["canceled", "lapsed"] as const) {
      const real = sub({ plan: "pro", status });
      const out = applyCompEntitlement(real, comp({ plan: "starter" }), NOW);
      expect(out.compApplied).toBe(true);
      expect(out.subscription.plan).toBe("starter");
      expect(out.subscription.status).toBe("active");
    }
  });

  it("applies during an active 14-day trial too (trial is not paid access)", () => {
    const trial = sub({ plan: "trial", status: "trialing" });
    const out = applyCompEntitlement(trial, comp(), NOW);
    expect(out.compApplied).toBe(true);
    expect(out.subscription.plan).toBe("pro");
  });
});

describe("COMP_DEFAULT_DAYS", () => {
  it("defaults grants to 90 days", () => {
    expect(COMP_DEFAULT_DAYS).toBe(90);
  });
});
