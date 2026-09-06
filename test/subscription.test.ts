import { describe, it, expect } from "vitest";
import { deriveSubscription, parseSubscriptionOverride } from "../src/subscription";
import type { TrialState } from "../src/trial";

const activeTrial: TrialState = {
  startedAt: "2026-08-20T00:00:00.000Z",
  endsAt: "2026-09-03T00:00:00.000Z",
  active: true,
};
const expiredTrial: TrialState = {
  startedAt: "2026-07-01T00:00:00.000Z",
  endsAt: "2026-07-15T00:00:00.000Z",
  active: false,
};
const notStartedTrial: TrialState = { startedAt: "", endsAt: "", active: false };

describe("deriveSubscription (trial fallback, placeholder until 56c)", () => {
  it("derives a trialing subscription from an active trial", () => {
    expect(deriveSubscription(activeTrial, undefined)).toEqual({
      plan: "trial",
      status: "trialing",
      renewsAt: "2026-09-03T00:00:00.000Z",
      manageBillingUrl: null,
    });
  });

  it("derives a lapsed subscription from an expired trial", () => {
    expect(deriveSubscription(expiredTrial, undefined)).toEqual({
      plan: "trial",
      status: "lapsed",
      renewsAt: "2026-07-15T00:00:00.000Z",
      manageBillingUrl: null,
    });
  });

  it("derives a trialing subscription with no renewal for a not-started trial", () => {
    expect(deriveSubscription(notStartedTrial, undefined)).toEqual({
      plan: "trial",
      status: "trialing",
      renewsAt: null,
      manageBillingUrl: null,
    });
  });
});

describe("deriveSubscription (privateMetadata.subscription override)", () => {
  it("uses a valid override verbatim instead of the trial derivation", () => {
    const override = {
      plan: "pro",
      status: "active",
      renewsAt: "2026-10-01T00:00:00.000Z",
      manageBillingUrl: "https://billing.example.com/portal/abc",
    };
    // Even with an active trial, a valid override wins.
    expect(deriveSubscription(activeTrial, override)).toEqual({
      ...override,
      manageBillingUrl: null,
    });
  });

  it("accepts each launch tier as a valid plan", () => {
    for (const plan of ["starter", "pro", "unlimited", "team", "none"] as const) {
      expect(deriveSubscription(activeTrial, { plan, status: "active" })).toEqual({
        plan,
        status: "active",
        renewsAt: null,
        manageBillingUrl: null,
      });
    }
  });

  it("ignores unknown reconciliation fields and legacy management URLs", () => {
    // The 56c webhook stores paddleSubscriptionId/priceId/updatedAt/lastEventId
    // etc.; parseSubscriptionOverride reads only the public wire fields. Stored
    // management URLs are temporary Paddle links, so they are not exposed.
    expect(
      deriveSubscription(activeTrial, {
        plan: "starter",
        status: "active",
        renewsAt: "2026-10-01T00:00:00.000Z",
        manageBillingUrl: "https://billing.example.com/p/1",
        paddleSubscriptionId: "sub_123",
        paddleCustomerId: "ctm_123",
        priceId: "pri_01m1syd7nfarp8pggpcnvjbgyy",
        updatedAt: "2026-09-05T00:00:00.000Z",
        lastEventId: "evt_1",
      }),
    ).toEqual({
      plan: "starter",
      status: "active",
      renewsAt: "2026-10-01T00:00:00.000Z",
      manageBillingUrl: null,
    });
  });

  it("accepts a minimal override (plan + status only) and nulls the optional fields", () => {
    expect(deriveSubscription(activeTrial, { plan: "team", status: "past_due" })).toEqual({
      plan: "team",
      status: "past_due",
      renewsAt: null,
      manageBillingUrl: null,
    });
  });

  it("falls back to the trial derivation when the override is invalid", () => {
    // Bad plan/status enum -> the whole override is treated as absent. "individual"
    // was the pre-56c tier and is no longer valid.
    for (const bad of [
      { plan: "premium", status: "on" },
      { plan: "individual", status: "active" },
    ]) {
      expect(deriveSubscription(activeTrial, bad)).toEqual({
        plan: "trial",
        status: "trialing",
        renewsAt: "2026-09-03T00:00:00.000Z",
        manageBillingUrl: null,
      });
    }
  });
});

describe("parseSubscriptionOverride", () => {
  it("returns null for non-objects and null", () => {
    expect(parseSubscriptionOverride(undefined)).toBeNull();
    expect(parseSubscriptionOverride(null)).toBeNull();
    expect(parseSubscriptionOverride("nope")).toBeNull();
    expect(parseSubscriptionOverride(42)).toBeNull();
  });

  it("returns null when plan or status is missing or off-enum", () => {
    expect(parseSubscriptionOverride({ status: "active" })).toBeNull();
    expect(parseSubscriptionOverride({ plan: "pro" })).toBeNull();
    expect(parseSubscriptionOverride({ plan: "pro", status: "bogus" })).toBeNull();
    expect(parseSubscriptionOverride({ plan: "bogus", status: "active" })).toBeNull();
    // "individual" was the pre-56c tier and is now off-enum.
    expect(parseSubscriptionOverride({ plan: "individual", status: "active" })).toBeNull();
  });

  it("drops a malformed renewsAt to null but keeps a valid record", () => {
    expect(
      parseSubscriptionOverride({ plan: "pro", status: "active", renewsAt: "not-a-date" }),
    ).toEqual({ plan: "pro", status: "active", renewsAt: null, manageBillingUrl: null });
  });

  it("drops parseable but non-canonical renewsAt values to null", () => {
    for (const renewsAt of [
      "12/01/2026",
      "2026-12-01",
      "2026-12-01T00:00:00Z",
      "2026-12-01T00:00:00.000+00:00",
      "2026-02-30T00:00:00.000Z",
    ]) {
      expect(parseSubscriptionOverride({ plan: "pro", status: "active", renewsAt })).toEqual({
        plan: "pro",
        status: "active",
        renewsAt: null,
        manageBillingUrl: null,
      });
    }
  });

  it("keeps canonical ISO renewsAt values", () => {
    expect(
      parseSubscriptionOverride({
        plan: "pro",
        status: "active",
        renewsAt: "2026-12-01T00:00:00.000Z",
      }),
    ).toEqual({
      plan: "pro",
      status: "active",
      renewsAt: "2026-12-01T00:00:00.000Z",
      manageBillingUrl: null,
    });
  });

  it("ignores legacy manageBillingUrl values", () => {
    for (const manageBillingUrl of [
      "https://billing.example.com/portal/abc",
      "http://insecure.example.com",
      "javascript:alert(1)",
    ]) {
      expect(
        parseSubscriptionOverride({
          plan: "pro",
          status: "active",
          manageBillingUrl,
        }),
      ).toEqual({ plan: "pro", status: "active", renewsAt: null, manageBillingUrl: null });
    }
  });
});
