import { describe, it, expect, vi, beforeEach } from "vitest";
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
    JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 2 } }),
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
      req("/v1/draft", { method: "POST", headers: bearer("bad"), body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) }),
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
      req("/v1/draft", { method: "POST", headers: bearer(), body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }) }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hi", usage: { inputTokens: 3, outputTokens: 2 } });
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
      req("/v1/draft", { method: "POST", headers: bearer(), body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("returns 402 trial_expired after 14 days and never calls Anthropic", async () => {
    const started = new Date(Date.now() - TRIAL_MS - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: started }));
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk());
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/draft", { method: "POST", headers: bearer(), body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }) }),
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/draft", { method: "POST", headers: bearer(), body: JSON.stringify({ messages: [{ role: "user", content: "draft" }] }) }),
      env,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.type).toBe("overloaded");
  });

  it("rejects a malformed body with 400", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: new Date().toISOString() }));
    const res = await worker.fetch(
      req("/v1/draft", { method: "POST", headers: bearer(), body: JSON.stringify({ messages: [] }) }),
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
