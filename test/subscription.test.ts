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
      plan: "individual",
      status: "active",
      renewsAt: "2026-10-01T00:00:00.000Z",
      manageBillingUrl: "https://billing.example.com/portal/abc",
    };
    // Even with an active trial, a valid override wins.
    expect(deriveSubscription(activeTrial, override)).toEqual(override);
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
    // Bad plan/status enum -> the whole override is treated as absent.
    expect(deriveSubscription(activeTrial, { plan: "premium", status: "on" })).toEqual({
      plan: "trial",
      status: "trialing",
      renewsAt: "2026-09-03T00:00:00.000Z",
      manageBillingUrl: null,
    });
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
    expect(parseSubscriptionOverride({ plan: "individual" })).toBeNull();
    expect(parseSubscriptionOverride({ plan: "individual", status: "bogus" })).toBeNull();
    expect(parseSubscriptionOverride({ plan: "bogus", status: "active" })).toBeNull();
  });

  it("drops a malformed renewsAt to null but keeps a valid record", () => {
    expect(
      parseSubscriptionOverride({ plan: "individual", status: "active", renewsAt: "not-a-date" }),
    ).toEqual({ plan: "individual", status: "active", renewsAt: null, manageBillingUrl: null });
  });

  it("drops a non-https manageBillingUrl to null", () => {
    expect(
      parseSubscriptionOverride({
        plan: "individual",
        status: "active",
        manageBillingUrl: "http://insecure.example.com",
      }),
    ).toEqual({ plan: "individual", status: "active", renewsAt: null, manageBillingUrl: null });
    expect(
      parseSubscriptionOverride({
        plan: "individual",
        status: "active",
        manageBillingUrl: "javascript:alert(1)",
      }),
    ).toEqual({ plan: "individual", status: "active", renewsAt: null, manageBillingUrl: null });
  });
});
