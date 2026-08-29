import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import { TRIAL_MS } from "../src/config";

// Mock @clerk/backend so JWT verification and user lookups are controllable.
const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  verifyToken: mocks.verifyToken,
  createClerkClient: () => ({
    users: { getUser: mocks.getUser, updateUserMetadata: mocks.updateUserMetadata },
  }),
}));

// Import AFTER the mock is registered.
import worker from "../src/index";

const env: Env = {
  ...testEnv,
  CLERK_SECRET_KEY: "sk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
};

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://sentwise-inference.test${path}`, init);
}

function bearer(token = "good-token"): HeadersInit {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function anthropicOk(text = "drafted") {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
    { status: 200 },
  );
}

function userWith(privateMetadata: Record<string, unknown>) {
  return {
    id: "user_123",
    primaryEmailAddressId: "ema_1",
    emailAddresses: [{ id: "ema_1", emailAddress: "marcus@example.com" }],
    privateMetadata,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.verifyToken.mockReset();
  mocks.getUser.mockReset();
  mocks.updateUserMetadata.mockReset();
});

describe("GET /healthz", () => {
  it("returns ok without auth", async () => {
    const res = await worker.fetch(req("/healthz"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const res = await worker.fetch(req("/v1/draft", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.type).toBe("unauthenticated");
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid JWT with 401", async () => {
    mocks.verifyToken.mockRejectedValue(new Error("bad signature"));
    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer("bad"),
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.type).toBe("session_invalid");
  });
});

describe("POST /v1/draft trial handling", () => {
  it("initializes the trial on the first authenticated call and forwards to Anthropic", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({})); // no trialStartedAt yet
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("hi"));
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
    const drafted = (await res.json()) as any;
    expect(drafted.text).toBe("hi");
    expect(drafted.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    // 56b: the draft response now also carries the quota snapshot.
    expect(drafted.quota.unit).toBe("drafts");
    expect(drafted.quota.used).toBe(1);
    // Trial initialized in privateMetadata
    expect(mocks.updateUserMetadata).toHaveBeenCalledOnce();
    const arg = mocks.updateUserMetadata.mock.calls[0][1];
    expect(typeof arg.privateMetadata.trialStartedAt).toBe("string");
    // Anthropic actually called
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not re-initialize when a trial already exists and is active", async () => {
    const started = new Date(Date.now() - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: started }));
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk());
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
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("re-initializes the trial when trialStartedAt is unparseable", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: "not-a-real-date" }));
    mocks.updateUserMetadata.mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("hi"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }),
      }),
      env,
    );

    // Treated as not-started -> re-initialized and allowed (not permanently expired).
    expect(res.status).toBe(200);
    expect(mocks.updateUserMetadata).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns 402 trial_expired after 14 days and never calls Anthropic", async () => {
    const started = new Date(Date.now() - TRIAL_MS - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: started }));
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk());
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }),
      }),
      env,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("trial_expired");
    expect(typeof body.error.trialEndsAt).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an Anthropic error to a clean JSON error", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: new Date().toISOString() }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
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
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.type).toBe("overloaded");
  });

  it("rejects a malformed body with 400", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: new Date().toISOString() }));
    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ messages: [] }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
  });
});

describe("GET /v1/me", () => {
  it("returns account info without starting a trial", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({})); // no trial yet
    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.userId).toBe("user_123");
    expect(body.email).toBe("marcus@example.com");
    expect(body.trial.active).toBe(false);
    // /v1/me must NOT initialize a trial
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("reports an active trial window when one exists", async () => {
    const started = new Date(Date.now() - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: started }));
    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const body = (await res.json()) as any;
    expect(body.trial.active).toBe(true);
    expect(body.trial.startedAt).toBe(started);
  });
});

describe("routing", () => {
  it("405s a known path with the wrong method", async () => {
    const res = await worker.fetch(req("/v1/draft", { method: "GET" }), env);
    expect(res.status).toBe(405);
  });
  it("404s an unknown path", async () => {
    const res = await worker.fetch(req("/nope"), env);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 56b — metering + limits, end to end through the Worker (real AccountQuota DO).
// ---------------------------------------------------------------------------

function activeTrial() {
  return userWith({ trialStartedAt: new Date(Date.now() - 1000).toISOString() });
}

function draftReq(sub: string, content = "draft this") {
  mocks.verifyToken.mockResolvedValue({ sub });
  return req("/v1/draft", {
    method: "POST",
    headers: bearer(),
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}

describe("56b draft metering", () => {
  it("returns the quota snapshot alongside the draft", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-quota" });
    mocks.getUser.mockResolvedValue(activeTrial());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));

    const res = await worker.fetch(draftReq("u-quota"), env);
    expect(res.status).toBe(200);
    const q = ((await res.json()) as any).quota;
    expect(q).toMatchObject({
      unit: "drafts",
      used: 1,
      limit: 100, // WEEKLY_DRAFT_LIMIT var default
      remaining: 99,
      tokenLimit: 2_000_000,
      enforcement: "soft",
      extraPurchased: 0,
    });
    expect(q.tokensUsed).toBe(5); // 3 in + 2 out from anthropicOk
    expect(typeof q.resetsAt).toBe("string");
    expect(Number.isNaN(Date.parse(q.resetsAt))).toBe(false);
  });

  it("adds purchased extras to the limit (extraPurchased)", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-extra" });
    mocks.getUser.mockResolvedValue(
      userWith({
        trialStartedAt: new Date(Date.now() - 1000).toISOString(),
        quota: { extraDrafts: 5 },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));

    const res = await worker.fetch(draftReq("u-extra"), env);
    const q = ((await res.json()) as any).quota;
    expect(q.limit).toBe(105);
    expect(q.extraPurchased).toBe(5);
    expect(q.remaining).toBe(104);
  });

  it("rate limits with a 429 + Retry-After once the per-minute cap is hit", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-rate" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const rlEnv: Env = { ...env, RATE_LIMIT_PER_MIN: "1" };

    const first = await worker.fetch(draftReq("u-rate"), rlEnv);
    expect(first.status).toBe(200);

    const second = await worker.fetch(draftReq("u-rate"), rlEnv);
    expect(second.status).toBe(429);
    const body = (await second.json()) as any;
    expect(body.error.type).toBe("rate_limited");
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    // The rate-limited request never reached Anthropic.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an over-cap request with 413 request_too_large before forwarding", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-big" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    // maxTokensPerRequest = 10; even a tiny request (chars/4 + DEFAULT_MAX_TOKENS) exceeds it.
    const capEnv: Env = { ...env, MAX_TOKENS_PER_REQUEST: "10" };

    const res = await worker.fetch(draftReq("u-big"), capEnv);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.type).toBe("request_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hard enforcement blocks an over-quota draft with 429 quota_exceeded", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-hard" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const hardEnv: Env = { ...env, WEEKLY_DRAFT_LIMIT: "1", ENFORCEMENT_MODE: "hard" };

    const first = await worker.fetch(draftReq("u-hard"), hardEnv);
    expect(first.status).toBe(200); // draftsUsed -> 1

    const second = await worker.fetch(draftReq("u-hard"), hardEnv);
    expect(second.status).toBe(429);
    const body = (await second.json()) as any;
    expect(body.error.type).toBe("quota_exceeded");
    expect(typeof body.error.resetsAt).toBe("string");
    expect(fetchMock).toHaveBeenCalledOnce(); // blocked before the 2nd forward
  });

  it("soft enforcement meters past the cap but keeps drafting", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-soft" });
    mocks.getUser.mockResolvedValue(activeTrial());
    // Fresh Response per call — the body is single-use and this test forwards twice.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => anthropicOk("ok")),
    );
    const softEnv: Env = { ...env, WEEKLY_DRAFT_LIMIT: "1", ENFORCEMENT_MODE: "soft" };

    expect((await worker.fetch(draftReq("u-soft"), softEnv)).status).toBe(200);
    const res2 = await worker.fetch(draftReq("u-soft"), softEnv);
    expect(res2.status).toBe(200);
    const q = ((await res2.json()) as any).quota;
    expect(q.used).toBe(2);
    expect(q.limit).toBe(1);
    expect(q.remaining).toBe(0); // clamped
  });
});

describe("56b /v1/me quota", () => {
  it("includes a zeroed quota snapshot", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-me" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.quota).toMatchObject({
      unit: "drafts",
      used: 0,
      limit: 100,
      remaining: 100,
      tokenLimit: 2_000_000,
      enforcement: "soft",
      extraPurchased: 0,
    });
    // Viewing the account must not start a trial or record usage.
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    // quotaOverride is internal and must not leak into the response.
    expect("quotaOverride" in body).toBe(false);
  });
});
