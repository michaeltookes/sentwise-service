// /admin/comp route + comp-entitlement account behavior (app-repo item 111).
//
// Covers: ADMIN_TOKEN auth parity with /admin/margin, grant/revoke/inspect by
// userId and by email, expiry validation, the audit datapoint, /v1/me reporting
// the comped tier exactly like a paid plan (with that tier's metering caps),
// lazy expiry back to the natural state, real-subscription-wins, drafting past
// the trial on a comp, graceful portal failure, and comp-safe account deletion.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import { TRIAL_MS } from "../src/config";

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUser: vi.fn(),
  getUserList: vi.fn(),
  updateUserMetadata: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  verifyToken: mocks.verifyToken,
  createClerkClient: () => ({
    users: {
      getUser: mocks.getUser,
      getUserList: mocks.getUserList,
      updateUserMetadata: mocks.updateUserMetadata,
    },
  }),
}));

// Import AFTER the mock is registered.
import worker from "../src/index";
import { __resetClerkUserCache } from "../src/clerk-user-cache";

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN = "admin-secret-token";

const env: Env = {
  ...testEnv,
  CLERK_SECRET_KEY: "sk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
};
const adminEnv: Env = { ...env, ADMIN_TOKEN: ADMIN };

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://sentwise-inference.test${path}`, init);
}

function adminReq(method: string, body?: unknown, token: string | null = ADMIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return req("/admin/comp", {
    method,
    headers,
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
}

function bearer(token = "good-token"): HeadersInit {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function userWith(privateMetadata: Record<string, unknown>, id = "user_123") {
  return {
    id,
    primaryEmailAddressId: "ema_1",
    emailAddresses: [{ id: "ema_1", emailAddress: "luciusfox@prowlqa.dev" }],
    privateMetadata,
  };
}

function expiredTrialStart(): string {
  return new Date(Date.now() - TRIAL_MS - 60_000).toISOString();
}

function activeComp(plan = "pro") {
  return {
    plan,
    grantedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  };
}

async function errType(res: Response): Promise<string> {
  const body: { error: { type: string } } = await res.json();
  return body.error.type;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.verifyToken.mockReset();
  mocks.getUser.mockReset();
  mocks.getUserList.mockReset();
  mocks.updateUserMetadata.mockReset();
  __resetClerkUserCache();
});

describe("/admin/comp auth gating (parity with /admin/margin)", () => {
  it("404s on every method when ADMIN_TOKEN is unset (endpoint invisible)", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await worker.fetch(adminReq(method, {}, "anything"), env);
      expect(res.status).toBe(404);
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("401s a missing, empty, or garbage bearer exactly like /admin/margin", async () => {
    for (const token of [null, "", "   ", "garbage-token"]) {
      const compRes = await worker.fetch(adminReq("POST", {}, token), adminEnv);
      const marginHeaders: HeadersInit = token !== null ? { Authorization: `Bearer ${token}` } : {};
      const marginRes = await worker.fetch(
        req("/admin/margin", { headers: marginHeaders }),
        adminEnv,
      );
      expect(compRes.status).toBe(401);
      expect(marginRes.status).toBe(401);
      expect(await errType(compRes)).toBe("unauthenticated");
      expect(await errType(marginRes)).toBe("unauthenticated");
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("405s an unsupported method when configured, 404s when not", async () => {
    expect((await worker.fetch(adminReq("PUT", {}), adminEnv)).status).toBe(405);
    expect((await worker.fetch(adminReq("PUT", {}), env)).status).toBe(404);
  });
});

describe("POST /admin/comp (grant)", () => {
  it("grants by userId with the default 90-day expiry and writes only the comp key", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const before = Date.now();

    const res = await worker.fetch(adminReq("POST", { userId: "user_123", plan: "pro" }), adminEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.granted).toBe(true);
    expect(body.userId).toBe("user_123");
    expect(body.email).toBe("luciusfox@prowlqa.dev");
    expect(body.plan).toBe("pro");
    const expiresMs = Date.parse(body.expiresAt);
    expect(expiresMs).toBeGreaterThanOrEqual(before + 90 * DAY_MS);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 90 * DAY_MS);

    expect(mocks.getUserList).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).toHaveBeenCalledOnce();
    const [, arg] = mocks.updateUserMetadata.mock.calls[0];
    expect(Object.keys(arg.privateMetadata)).toEqual(["comp"]);
    expect(arg.privateMetadata.comp).toEqual({
      plan: "pro",
      grantedAt: body.grantedAt,
      expiresAt: body.expiresAt,
    });
  });

  it("grants by email via Clerk getUserList (how the owner addresses the QA account)", async () => {
    mocks.getUserList.mockResolvedValue({ data: [{ id: "user_qa" }] });
    mocks.getUser.mockResolvedValue(userWith({}, "user_qa"));
    mocks.updateUserMetadata.mockResolvedValue(undefined);

    const res = await worker.fetch(
      adminReq("POST", { email: "luciusfox@prowlqa.dev", plan: "starter", days: 30 }),
      adminEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.userId).toBe("user_qa");
    expect(body.plan).toBe("starter");
    expect(Date.parse(body.expiresAt) - Date.parse(body.grantedAt)).toBe(30 * DAY_MS);
    expect(mocks.getUserList).toHaveBeenCalledWith({ emailAddress: ["luciusfox@prowlqa.dev"] });
  });

  it("404s an email with no matching account and 409s an ambiguous one", async () => {
    mocks.getUserList.mockResolvedValue({ data: [] });
    const notFound = await worker.fetch(
      adminReq("POST", { email: "nobody@example.com", plan: "pro" }),
      adminEnv,
    );
    expect(notFound.status).toBe(404);
    expect(await errType(notFound)).toBe("account_not_found");

    mocks.getUserList.mockResolvedValue({ data: [{ id: "user_a" }, { id: "user_b" }] });
    const ambiguous = await worker.fetch(
      adminReq("POST", { email: "shared@example.com", plan: "pro" }),
      adminEnv,
    );
    expect(ambiguous.status).toBe(409);
    expect(await errType(ambiguous)).toBe("account_ambiguous");
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("404s an unknown userId", async () => {
    mocks.getUser.mockRejectedValue({ status: 404 });
    const res = await worker.fetch(
      adminReq("POST", { userId: "user_gone", plan: "pro" }),
      adminEnv,
    );
    expect(res.status).toBe(404);
    expect(await errType(res)).toBe("account_not_found");
  });

  it("400s reserved/invalid plans — team is never grantable", async () => {
    for (const plan of ["team", "trial", "none", "gold", undefined]) {
      const res = await worker.fetch(adminReq("POST", { userId: "user_123", plan }), adminEnv);
      expect(res.status).toBe(400);
      expect(await errType(res)).toBe("invalid_request");
    }
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("400s bad account addressing (both, neither)", async () => {
    const both = await worker.fetch(
      adminReq("POST", { userId: "user_123", email: "x@y.z", plan: "pro" }),
      adminEnv,
    );
    expect(both.status).toBe(400);
    const neither = await worker.fetch(adminReq("POST", { plan: "pro" }), adminEnv);
    expect(neither.status).toBe(400);
  });

  it("validates expiry inputs: bad days, days+expiresAt, past expiresAt", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    for (const body of [
      { userId: "user_123", plan: "pro", days: 0 },
      { userId: "user_123", plan: "pro", days: 1.5 },
      { userId: "user_123", plan: "pro", days: 99999 },
      { userId: "user_123", plan: "pro", days: 30, expiresAt: "2099-01-01T00:00:00.000Z" },
      { userId: "user_123", plan: "pro", expiresAt: "2020-01-01T00:00:00.000Z" },
      { userId: "user_123", plan: "pro", expiresAt: "not-a-date" },
    ]) {
      const res = await worker.fetch(adminReq("POST", body), adminEnv);
      expect(res.status).toBe(400);
    }
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it.each([
    "10/08/2027",
    "Oct 8 2027",
    "2027-10-08",
    "2027-10-08 12:00:00Z",
    "2027-10-08T12:00:00",
    "2027-10-08T12:00:00.000",
    "2027-10-08T12:00:00Z trailing",
    "2027-13-08T12:00:00Z",
    "2027-10-08T25:00:00Z",
    "2027-10-08T12:00:00+25:00",
    "2027-02-29T12:00:00Z",
    "2027-04-31T12:00:00-05:00",
    1822996800000,
  ])("rejects invalid ISO expiresAt %j before accessing Clerk", async (expiresAt) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T12:00:00.000Z"));
    mocks.getUser.mockResolvedValue(userWith({}));
    const writeDataPoint = vi.fn();
    const res = await worker.fetch(
      adminReq("POST", { userId: "user_123", plan: "pro", expiresAt }),
      { ...adminEnv, USAGE_ANALYTICS: { writeDataPoint } },
    );
    expect(res.status).toBe(400);
    expect(await errType(res)).toBe("invalid_request");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it.each([
    ["2027-10-08T12:00:00.123Z", "2027-10-08T12:00:00.123Z"],
    ["2027-10-08T12:00:00Z", "2027-10-08T12:00:00.000Z"],
    ["2027-10-08T12:00:00.1Z", "2027-10-08T12:00:00.100Z"],
    ["2027-10-08T00:00:00+05:30", "2027-10-07T18:30:00.000Z"],
    ["2027-10-08T23:00:00.123-05:00", "2027-10-09T04:00:00.123Z"],
    ["2028-02-29T12:00:00Z", "2028-02-29T12:00:00.000Z"],
  ])("normalizes valid ISO expiresAt %s to UTC", async (expiresAt, normalized) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T12:00:00.000Z"));
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const res = await worker.fetch(
      adminReq("POST", { userId: "user_123", plan: "unlimited", expiresAt }),
      adminEnv,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).expiresAt).toBe(normalized);
    expect(mocks.updateUserMetadata).toHaveBeenCalledWith("user_123", {
      privateMetadata: {
        comp: {
          plan: "unlimited",
          grantedAt: "2026-10-08T12:00:00.000Z",
          expiresAt: normalized,
        },
      },
    });
  });

  it("emits a structured audit datapoint (hashed id / tier / action / expiry)", async () => {
    const writeDataPoint = vi.fn();
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const res = await worker.fetch(adminReq("POST", { userId: "user_123", plan: "pro" }), {
      ...adminEnv,
      USAGE_ANALYTICS: { writeDataPoint },
    });
    expect(res.status).toBe(200);
    const expiresAt = ((await res.json()) as any).expiresAt as string;
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.blobs[1]).toBe("pro");
    expect(point.blobs[2]).toBe("admin_comp_grant");
    expect(point.blobs[0]).toMatch(/^[0-9a-f]{64}$/); // hashed, never the raw id
    expect(point.blobs[0]).not.toContain("user_123");
    expect(point.doubles).toEqual([Date.parse(expiresAt)]);
  });
});

describe("DELETE /admin/comp (revoke)", () => {
  it("deletes the comp key and reports the previous grant", async () => {
    const comp = activeComp("pro");
    mocks.getUser.mockResolvedValue(userWith({ comp }));
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const writeDataPoint = vi.fn();

    const res = await worker.fetch(adminReq("DELETE", { userId: "user_123" }), {
      ...adminEnv,
      USAGE_ANALYTICS: { writeDataPoint },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.revoked).toBe(true);
    expect(body.previous).toEqual(comp);
    expect(mocks.updateUserMetadata).toHaveBeenCalledWith("user_123", {
      privateMetadata: { comp: null },
    });
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.blobs[1]).toBe("pro");
    expect(point.blobs[2]).toBe("admin_comp_revoke");
  });

  it("is idempotent when no comp exists", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const res = await worker.fetch(adminReq("DELETE", { userId: "user_123" }), adminEnv);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).previous).toBeNull();
  });
});

describe("GET /admin/comp (inspect)", () => {
  it("reports the comp record and whether it is active", async () => {
    const comp = activeComp("starter");
    mocks.getUser.mockResolvedValue(userWith({ comp }));
    const res = await worker.fetch(
      req("/admin/comp?userId=user_123", { headers: { Authorization: `Bearer ${ADMIN}` } }),
      adminEnv,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({
      userId: "user_123",
      email: "luciusfox@prowlqa.dev",
      comp,
      active: true,
    });
  });

  it("reports an expired comp as inactive and a missing one as null", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({ comp: { ...activeComp("pro"), expiresAt: "2020-01-01T00:00:00.000Z" } }),
    );
    const expired = (await (
      await worker.fetch(
        req("/admin/comp?userId=user_123", { headers: { Authorization: `Bearer ${ADMIN}` } }),
        adminEnv,
      )
    ).json()) as any;
    expect(expired.active).toBe(false);

    mocks.getUser.mockResolvedValue(userWith({}));
    const missing = (await (
      await worker.fetch(
        req("/admin/comp?userId=user_123", { headers: { Authorization: `Bearer ${ADMIN}` } }),
        adminEnv,
      )
    ).json()) as any;
    expect(missing.comp).toBeNull();
    expect(missing.active).toBe(false);
  });
});

describe("GET /v1/me with a comp entitlement", () => {
  it("reports the comped tier exactly like a paid plan, with that tier's caps", async () => {
    const comp = activeComp("pro");
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: expiredTrialStart(), comp }));

    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Indistinguishable from a paid pro plan; renewsAt carries the comp expiry.
    expect(body.subscription).toEqual({
      plan: "pro",
      status: "active",
      renewsAt: comp.expiresAt,
      manageBillingUrl: null,
    });
    // No comp marker leaks on the wire.
    expect(body).not.toHaveProperty("comp");
    // Metering caps follow the granted tier (wrangler PRO_DRAFT_LIMIT = 120),
    // and enforcement is the paid-tier env mode, not the trial's forced "hard".
    expect(body.quota.limit).toBe(120);
    expect(body.quota.enforcement).toBe("soft");
  });

  it("applies the granted tier's own cap for starter and unlimited", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    for (const [plan, limit] of [
      ["starter", 30],
      ["unlimited", 100000],
    ] as const) {
      __resetClerkUserCache();
      mocks.getUser.mockResolvedValue(
        userWith({ trialStartedAt: expiredTrialStart(), comp: activeComp(plan) }),
      );
      const body = (await (
        await worker.fetch(req("/v1/me", { headers: bearer() }), env)
      ).json()) as any;
      expect(body.subscription.plan).toBe(plan);
      expect(body.quota.limit).toBe(limit);
    }
  });

  it("reverts to the natural lapsed-trial state once the comp expires", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        trialStartedAt: expiredTrialStart(),
        comp: { ...activeComp("pro"), expiresAt: "2020-01-01T00:00:00.000Z" },
      }),
    );
    const body = (await (
      await worker.fetch(req("/v1/me", { headers: bearer() }), env)
    ).json()) as any;
    expect(body.subscription.plan).toBe("trial");
    expect(body.subscription.status).toBe("lapsed");
    expect(body.quota.limit).toBe(400); // base monthly default, not a tier cap
    expect(body.quota.enforcement).toBe("hard"); // trial accounts stay hard-enforced
  });

  it("lets a real paid subscription win over the comp (comp inert)", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        trialStartedAt: expiredTrialStart(),
        subscription: {
          plan: "starter",
          status: "active",
          renewsAt: "2026-11-01T00:00:00.000Z",
          paddleSubscriptionId: "sub_real",
        },
        quota: { monthlyDraftLimit: 30 },
        comp: activeComp("unlimited"),
      }),
    );
    const body = (await (
      await worker.fetch(req("/v1/me", { headers: bearer() }), env)
    ).json()) as any;
    expect(body.subscription.plan).toBe("starter"); // real subscription, not the comp
    expect(body.quota.limit).toBe(30); // webhook-written starter cap, not unlimited's
  });
});

describe("comped account behavior across the worker", () => {
  it("drafts past the expired trial (the comp grants paid access)", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_comp_draft" });
    mocks.getUser.mockResolvedValue(
      userWith({ trialStartedAt: expiredTrialStart(), comp: activeComp("pro") }, "user_comp_draft"),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "drafted" }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).text).toBe("drafted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails portal-link requests gracefully for a comp with no real Paddle subscription", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({ trialStartedAt: expiredTrialStart(), comp: activeComp("pro") }),
    );
    const res = await worker.fetch(req("/v1/paddle/manage-billing", { headers: bearer() }), env);
    expect(res.status).toBe(404); // clean error, never a 500
    expect(await errType(res)).toBe("billing_subscription_not_found");
  });

  it("does not block account deletion behind the comp-derived subscription", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_comp_delete" });
    mocks.getUser.mockResolvedValue(
      userWith(
        { trialStartedAt: expiredTrialStart(), comp: activeComp("pro") },
        "user_comp_delete",
      ),
    );
    // Clerk DELETE /v1/users/:id succeeds.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(res.status).toBe(204);
  });
});
