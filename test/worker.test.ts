import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import { CLERK_DELETE_TIMEOUT_MS, TRIAL_MS } from "../src/config";
import { mondayStartUtc, RESERVATION_TTL_MS, WEEK_MS, type WindowState } from "../src/metering";

// Mock @clerk/backend so JWT verification and user lookups are controllable.
const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  verifyToken: mocks.verifyToken,
  createClerkClient: () => ({
    users: {
      getUser: mocks.getUser,
      updateUserMetadata: mocks.updateUserMetadata,
      deleteUser: mocks.deleteUser,
    },
  }),
}));

// Import AFTER the mock is registered.
import worker from "../src/index";
import { clerkUserExists } from "../src/auth";
import { buildPaddleCheckoutCustomData } from "../src/paddle-account";
import {
  PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY,
  PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY,
} from "../src/quota-do";

const env: Env = {
  ...testEnv,
  CLERK_SECRET_KEY: "sk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
};

const STARTER_PRICE = "pri_01m1syd7nfarp8pggpcnvjbgyy";
const PRO_PRICE = "pri_01m1symsxarc4c3jdea0ntb09w";
const UNLIMITED_PRICE = "pri_01m1syrdg05f49kz705gbzn6tz";
const OVERAGE_PRICE = "pri_overage";
const PADDLE_SECRET = "pdl_ntfset_testsecret";
const ACCOUNT_DELETION_KEY = "account_deletion";
const MON = Date.parse("2024-01-01T00:00:00.000Z");

function usageAnalytics() {
  const writeDataPoint = vi.fn();
  return {
    dataset: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    writeDataPoint,
  };
}

async function clearAccountDeletionState(userId: string): Promise<void> {
  const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.delete(ACCOUNT_DELETION_KEY);
    await state.storage.deleteAlarm();
  });
}

async function clearPaddleCheckoutReservations(userId: string): Promise<void> {
  const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.delete(PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY);
    await state.storage.delete(PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY);
  });
}

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

function clerkDeleteResponse(status = 200) {
  return new Response(JSON.stringify({ deleted: status >= 200 && status < 300 }), { status });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string" || input instanceof URL) return String(input);
  return input.url;
}

function isClerkDelete(input: RequestInfo | URL, init?: RequestInit): boolean {
  return (
    requestUrl(input).startsWith("https://api.clerk.com/v1/users/") && init?.method === "DELETE"
  );
}

function isClerkUserLookup(input: RequestInfo | URL, init?: RequestInit): boolean {
  return requestUrl(input).startsWith("https://api.clerk.com/v1/users/") && !init?.method;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function userWith(privateMetadata: Record<string, unknown>) {
  return {
    id: "user_123",
    primaryEmailAddressId: "ema_1",
    emailAddresses: [{ id: "ema_1", emailAddress: "marcus@example.com" }],
    privateMetadata,
  };
}

function internalUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function internalBody(init: RequestInit | undefined): {
  now?: number;
  attemptId?: string;
  reservationId?: string;
  reservationWindowStart?: number;
  estimatedTokens?: number;
  tokensDelta?: number;
} {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as {
    now?: number;
    attemptId?: string;
    reservationId?: string;
    reservationWindowStart?: number;
    estimatedTokens?: number;
    tokensDelta?: number;
  };
}

function quotaNamespaceWithSettleFailure(now: number): {
  namespace: DurableObjectNamespace;
  settleCalls: () => number;
  deferCalls: () => number;
  deferredSettlements: () => Array<ReturnType<typeof internalBody>>;
} {
  const windowStart = mondayStartUtc(now);
  let window: WindowState = {
    windowStart,
    resetsAt: windowStart + WEEK_MS,
    draftsUsed: 0,
    tokensUsed: 0,
  };
  let settleCalls = 0;
  let deferCalls = 0;
  const deferredSettlements: Array<ReturnType<typeof internalBody>> = [];
  const stub = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = internalUrl(input).pathname;
      const body = internalBody(init);
      if (path === "/check") {
        return Promise.resolve(Response.json({ allowed: true, retryAfterSeconds: 0, window }));
      }
      if (path === "/reserve") {
        const estimatedTokens = body.estimatedTokens ?? 0;
        window = {
          ...window,
          draftsUsed: window.draftsUsed + 1,
          tokensReserved: (window.tokensReserved ?? 0) + estimatedTokens,
          activeReservations: [
            ...(window.activeReservations ?? []),
            {
              id: body.reservationId ?? "",
              estimatedTokens,
              expiresAt: (body.now ?? now) + RESERVATION_TTL_MS,
            },
          ],
        };
        return Promise.resolve(
          Response.json({
            reserved: true,
            blockedByQuota: false,
            reservationId: body.reservationId,
            estimatedTokens,
            window,
          }),
        );
      }
      if (path === "/settle") {
        settleCalls += 1;
        return Promise.reject(new Error("settle failed"));
      }
      if (path === "/defer-settlement") {
        deferCalls += 1;
        deferredSettlements.push(body);
        return Promise.resolve(Response.json({ window, queued: true }));
      }
      if (path === "/release") {
        if (body.reservationWindowStart === window.windowStart) {
          const reservation = (window.activeReservations ?? []).find(
            (r) => r.id === body.reservationId,
          );
          window = {
            ...window,
            draftsUsed: reservation ? Math.max(0, window.draftsUsed - 1) : window.draftsUsed,
            tokensReserved: reservation
              ? Math.max(0, (window.tokensReserved ?? 0) - reservation.estimatedTokens)
              : window.tokensReserved,
            activeReservations: (window.activeReservations ?? []).filter(
              (r) => r.id !== body.reservationId,
            ),
          };
        }
        return Promise.resolve(Response.json({ window }));
      }
      if (path === "/peek") {
        return Promise.resolve(Response.json({ window }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }),
  };
  return {
    namespace: {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => stub as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace,
    settleCalls: () => settleCalls,
    deferCalls: () => deferCalls,
    deferredSettlements: () => deferredSettlements,
  };
}

function quotaNamespaceWithDeletionFailures(options: {
  cancelFailures?: number;
  finishFailures?: number;
  cancelMismatch?: boolean;
}): {
  namespace: DurableObjectNamespace;
  cancelCalls: () => number;
  finishCalls: () => number;
} {
  let deleting = false;
  let deleted = false;
  const attemptIds = new Set<string>();
  let cancelCalls = 0;
  let finishCalls = 0;
  const windowStart = mondayStartUtc(Date.now());
  const window: WindowState = {
    windowStart,
    resetsAt: windowStart + WEEK_MS,
    draftsUsed: 1,
    tokensUsed: 5,
  };
  const stub = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = internalUrl(input).pathname;
      const body = internalBody(init);
      if (path === "/begin-delete") {
        deleting = true;
        attemptIds.add(body.attemptId ?? "");
        return Promise.resolve(
          Response.json({
            deleting: true,
            alreadyDeleted: false,
            attemptId: body.attemptId,
          }),
        );
      }
      if (path === "/cancel-delete") {
        cancelCalls += 1;
        if (cancelCalls <= (options.cancelFailures ?? 0)) {
          return Promise.reject(new Error("cancel failed"));
        }
        const wasDeleting =
          deleting && attemptIds.has(body.attemptId ?? "") && !options.cancelMismatch;
        if (!options.cancelMismatch) {
          attemptIds.delete(body.attemptId ?? "");
          deleting = attemptIds.size > 0;
        }
        return Promise.resolve(
          Response.json({ cancelled: wasDeleting, barrierActive: deleting || deleted }),
        );
      }
      if (path === "/finish-delete") {
        finishCalls += 1;
        if (finishCalls <= (options.finishFailures ?? 0)) {
          return Promise.reject(new Error("finish failed"));
        }
        deleting = false;
        deleted = true;
        attemptIds.clear();
        return Promise.resolve(Response.json({ deleted: true, cleanupPending: false }));
      }
      if (
        path === "/paddle-subscription-checkout-peek" ||
        path === "/paddle-overage-checkout-peek"
      ) {
        return Promise.resolve(Response.json({ pending: false }));
      }
      if (path === "/peek") {
        if (deleted) {
          return Promise.resolve(
            Response.json(
              { error: { type: "account_deleted", message: "This account has been deleted." } },
              { status: 410 },
            ),
          );
        }
        if (deleting) {
          return Promise.resolve(
            Response.json(
              {
                error: {
                  type: "account_deletion_in_progress",
                  message: "Account deletion is in progress.",
                },
              },
              { status: 409 },
            ),
          );
        }
        return Promise.resolve(Response.json({ window }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }),
  };
  return {
    namespace: {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => stub as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace,
    cancelCalls: () => cancelCalls,
    finishCalls: () => finishCalls,
  };
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.verifyToken.mockReset();
  mocks.getUser.mockReset();
  mocks.updateUserMetadata.mockReset();
  mocks.deleteUser.mockReset();
  await clearPaddleCheckoutReservations("user_123");
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

  it("bounds Clerk user existence lookups with an abort signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));
    try {
      const lookupStarted = deferred<void>();
      let aborted = false;
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        lookupStarted.resolve();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const lookup = clerkUserExists("user_lookup_timeout", env);
      const rejected = expect(lookup).rejects.toMatchObject({ name: "AbortError" });
      await lookupStarted.promise;
      await vi.advanceTimersByTimeAsync(CLERK_DELETE_TIMEOUT_MS);

      await rejected;
      expect(aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.clerk.com/v1/users/user_lookup_timeout",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("lets an active paid subscription draft after the trial has expired (56c)", async () => {
    const started = new Date(Date.now() - TRIAL_MS - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({ trialStartedAt: started, subscription: { plan: "pro", status: "active" } }),
    );
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("paid draft"));
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
    expect(((await res.json()) as any).text).toBe("paid draft");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still 402s an expired trial whose subscription is canceled (56c)", async () => {
    const started = new Date(Date.now() - TRIAL_MS - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({ trialStartedAt: started, subscription: { plan: "pro", status: "canceled" } }),
    );
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
    expect(((await res.json()) as any).error.type).toBe("trial_expired");
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

  // 73 — subscription field (placeholder derived from the trial until 56c).
  it("derives a not-started subscription before the trial begins", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({})); // no trial yet
    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const body = (await res.json()) as any;
    expect(body.subscription).toEqual({
      plan: "trial",
      status: "trialing",
      renewsAt: null,
      manageBillingUrl: null,
    });
  });

  it("derives a trialing subscription with renewsAt from an active trial", async () => {
    const started = new Date(Date.now() - 1000).toISOString();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: started }));
    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const body = (await res.json()) as any;
    expect(body.subscription.plan).toBe("trial");
    expect(body.subscription.status).toBe("trialing");
    expect(body.subscription.renewsAt).toBe(body.trial.endsAt);
    expect(body.subscription.manageBillingUrl).toBeNull();
  });

  it("uses a valid privateMetadata.subscription override without exposing stored billing URLs", async () => {
    const override = {
      plan: "pro",
      status: "active",
      renewsAt: "2026-12-01T00:00:00.000Z",
      manageBillingUrl: "https://billing.example.com/p/abc",
    };
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        trialStartedAt: new Date(Date.now() - 1000).toISOString(),
        subscription: override,
      }),
    );
    const res = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const body = (await res.json()) as any;
    expect(body.subscription).toEqual({ ...override, manageBillingUrl: null });
  });
});

describe("GET /v1/paddle/manage-billing", () => {
  const paddleEnv: Env = {
    ...env,
    PADDLE_API_KEY: "pdl_apikey",
    PADDLE_API_BASE: "https://sandbox-api.paddle.com",
  };

  it("returns a fresh Paddle management URL", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
        },
      }),
    );
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              management_urls: {
                update_payment_method: "https://portal.paddle.com/manage/sub_123",
                cancel: "https://portal.paddle.com/cancel/sub_123",
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managementUrl: "https://portal.paddle.com/manage/sub_123",
    });
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/subscriptions/sub_123",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer pdl_apikey" }),
      }),
    );
  });

  it("returns Paddle's cancellation management URL when requested", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                management_urls: {
                  update_payment_method: "https://portal.paddle.com/manage/sub_123",
                  cancel: "https://portal.paddle.com/cancel/sub_123",
                },
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing?action=cancel", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managementUrl: "https://portal.paddle.com/cancel/sub_123",
    });
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("404s when the account has no Paddle subscription id", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({ subscription: { plan: "trial", status: "trialing" } }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when Paddle does not provide a valid management URL", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { plan: "pro", status: "active", paddleSubscriptionId: "sub_123" },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }))),
    );

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("billing_portal_unavailable");
  });

  // ---- item 91: authenticated customer-portal-session deep links ----

  const portalSessionBody = (subId = "sub_123") =>
    JSON.stringify({
      data: {
        urls: {
          general: { overview: "https://portal.paddle.com/overview" },
          subscriptions: [
            {
              id: subId,
              cancel_subscription: "https://portal.paddle.com/session/cancel/sub_123",
              update_subscription_payment_method:
                "https://portal.paddle.com/session/update/sub_123",
            },
          ],
        },
      },
    });

  const isPortalSessionCreate = (input: RequestInfo | URL, init?: RequestInit) =>
    requestUrl(input).endsWith("/customers/ctm_123/portal-sessions") && init?.method === "POST";

  const isSubscriptionGet = (input: RequestInfo | URL, init?: RequestInit) =>
    requestUrl(input).endsWith("/subscriptions/sub_123") && !init?.method;

  it("returns a portal-session deep link for update_payment_method when a customer id is stored", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
      }),
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (isPortalSessionCreate(input, init)) {
        return Promise.resolve(new Response(portalSessionBody(), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${requestUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managementUrl: "https://portal.paddle.com/session/update/sub_123",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/customers/ctm_123/portal-sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ subscription_ids: ["sub_123"] }),
      }),
    );
  });

  it("returns the portal-session cancel deep link for action=cancel", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (isPortalSessionCreate(input, init)) {
          return Promise.resolve(new Response(portalSessionBody(), { status: 200 }));
        }
        throw new Error(`unexpected fetch: ${requestUrl(input)}`);
      }),
    );

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing?action=cancel", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managementUrl: "https://portal.paddle.com/session/cancel/sub_123",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("recovers a missing customer id from the live subscription, then mints a session", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { plan: "pro", status: "active", paddleSubscriptionId: "sub_123" },
      }),
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (isSubscriptionGet(input, init)) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { customer_id: "ctm_123", status: "active" } }), {
            status: 200,
          }),
        );
      }
      if (isPortalSessionCreate(input, init)) {
        return Promise.resolve(new Response(portalSessionBody(), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${requestUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing?action=cancel", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managementUrl: "https://portal.paddle.com/session/cancel/sub_123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/subscriptions/sub_123",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer pdl_apikey" }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/customers/ctm_123/portal-sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to the management_urls link when the portal-session create fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
      }),
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (isPortalSessionCreate(input, init)) {
        return Promise.resolve(new Response(JSON.stringify({ error: {} }), { status: 500 }));
      }
      if (isSubscriptionGet(input, init)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                management_urls: {
                  update_payment_method: "https://portal.paddle.com/manage/sub_123",
                  cancel: "https://portal.paddle.com/cancel/sub_123",
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
      throw new Error(`unexpected fetch: ${requestUrl(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/manage-billing?action=cancel", { headers: bearer() }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      managementUrl: "https://portal.paddle.com/cancel/sub_123",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/customers/ctm_123/portal-sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("POST /v1/paddle/checkout", () => {
  const paddleEnv: Env = {
    ...env,
    PADDLE_WEBHOOK_SECRET: PADDLE_SECRET,
    PADDLE_API_KEY: "pdl_apikey",
    PADDLE_API_BASE: "https://sandbox-api.paddle.com",
    EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE,
  };

  it("creates a server-authenticated Paddle transaction checkout", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: "txn_123",
              checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_123" },
            },
          }),
          { status: 201 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: "txn_123",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/transactions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer pdl_apikey" }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, any>;
    expect(body).toMatchObject({
      collection_mode: "automatic",
      items: [{ price_id: PRO_PRICE, quantity: 1 }],
      checkout: { url: null },
    });
    expect(body.customer_id).toBeUndefined();
    expect(body.custom_data).toMatchObject({ clerkUserId: "user_123" });
    expect(body.custom_data.sentwiseCheckoutBinding).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(body.custom_data.sentwiseCheckoutReservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("rejects a concurrent subscription checkout while one is pending", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const createStarted = deferred<void>();
    const createDone = deferred<Response>();
    const fetchMock = vi.fn(() => {
      createStarted.resolve();
      return createDone.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    await createStarted.promise;

    const second = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.type).toBe("billing_checkout_pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    createDone.resolve(
      new Response(
        JSON.stringify({
          data: {
            id: "txn_123",
            checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_123" },
          },
        }),
        { status: 201 },
      ),
    );
    expect((await first).status).toBe(200);
  });

  it("returns a still-usable pending subscription checkout transaction", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_123",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_123" },
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions/txn_123") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_123",
                status: "draft",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_123" },
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    expect(first.status).toBe(200);

    const second = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      transactionId: "txn_123",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_123",
    });
    const transactionCreates = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === "https://sandbox-api.paddle.com/transactions" &&
        init?.method === "POST",
    );
    expect(transactionCreates).toHaveLength(1);
  });

  it("rejects a recovered subscription checkout for a different tier", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_123",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_123" },
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions/txn_123") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_123",
                status: "draft",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_123" },
                items: [{ price: { id: PRO_PRICE }, quantity: 1 }],
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    expect(first.status).toBe(200);

    const second = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: STARTER_PRICE }),
      }),
      paddleEnv,
    );

    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error.type).toBe("billing_checkout_conflict");
    const transactionCreates = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === "https://sandbox-api.paddle.com/transactions" &&
        init?.method === "POST",
    );
    expect(transactionCreates).toHaveLength(1);
  });

  it("releases a canceled pending subscription checkout before creating another", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const transactionIds = ["txn_abandoned", "txn_retry"];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        const id = transactionIds.shift() ?? "txn_extra";
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id,
                checkout: { url: `https://checkout.paddle.com/pay?_ptxn=${id}` },
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions/txn_abandoned") {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { id: "txn_abandoned", status: "canceled" } }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    expect(first.status).toBe(200);

    const retry = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      transactionId: "txn_retry",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_retry",
    });
    const transactionCreates = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === "https://sandbox-api.paddle.com/transactions" &&
        init?.method === "POST",
    );
    expect(transactionCreates).toHaveLength(2);
  });

  it("rechecks subscription state after reserving a serialized checkout slot", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValueOnce(userWith({ subscription: null })).mockResolvedValueOnce(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_active");
    expect(fetchMock).not.toHaveBeenCalled();
    const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName("user_123"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY)).toBe(
        undefined,
      );
    });
  });

  it("releases a subscription checkout reservation when the account recheck fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser
      .mockResolvedValueOnce(userWith({ subscription: null }))
      .mockRejectedValueOnce(new Error("clerk unavailable"))
      .mockResolvedValue(userWith({ subscription: null }));
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: "txn_retry",
              checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_retry" },
            },
          }),
          { status: 201 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    expect(first.status).toBe(502);
    expect(((await first.json()) as any).error.type).toBe("account_lookup_failed");
    expect(fetchMock).not.toHaveBeenCalled();

    const retry = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      transactionId: "txn_retry",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels and releases a subscription checkout transaction when recording it fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const releaseBodies: Array<{ reservationId?: string }> = [];
    let recordCalls = 0;
    let pendingReservation:
      { reservationId: string; priceId: string; quantity: number } | undefined;
    const quotaStub = {
      fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestUrl(input).replace("https://account-quota.internal", "");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (path === "/paddle-subscription-checkout-reserve") {
          if (pendingReservation) {
            return Promise.resolve(Response.json({ pending: true, ...pendingReservation }));
          }
          pendingReservation = {
            reservationId: body.reservationId,
            priceId: body.priceId,
            quantity: body.quantity,
          };
          return Promise.resolve(
            Response.json({ reserved: true, reservationId: body.reservationId }),
          );
        }
        if (path === "/paddle-subscription-checkout-record") {
          recordCalls += 1;
          if (recordCalls > 1) {
            return Promise.resolve(Response.json({ recorded: true }));
          }
          return Promise.resolve(
            Response.json(
              { error: { type: "checkout_record_failed", message: "Could not record checkout." } },
              { status: 502 },
            ),
          );
        }
        if (path === "/paddle-subscription-checkout-release") {
          releaseBodies.push(body);
          if (pendingReservation?.reservationId === body.reservationId) {
            pendingReservation = undefined;
          }
          return Promise.resolve(Response.json({ released: true }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    };
    const quotaEnv: Env = {
      ...paddleEnv,
      ACCOUNT_QUOTA: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => quotaStub as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    };
    const transactionIds = ["txn_123", "txn_retry"];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (
        url === "https://sandbox-api.paddle.com/transactions/txn_123" &&
        init?.method === "PATCH"
      ) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      const id = transactionIds.shift() ?? "txn_extra";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id,
              checkout: { url: `https://checkout.paddle.com/pay?_ptxn=${id}` },
            },
          }),
          { status: 201 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      quotaEnv,
    );

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("checkout_record_failed");
    expect(releaseBodies).toHaveLength(1);
    expect(releaseBodies[0].reservationId).toEqual(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/transactions/txn_123",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "canceled" }),
      }),
    );

    const retry = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      quotaEnv,
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      transactionId: "txn_retry",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_retry",
    });
    const transactionCreates = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === "https://sandbox-api.paddle.com/transactions" &&
        init?.method === "POST",
    );
    expect(transactionCreates).toHaveLength(2);
  });

  it("keeps a subscription checkout reservation when Paddle creation outcome is unknown", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network failed after request"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "txn_retry",
              checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_retry" },
            },
          }),
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    expect(first.status).toBe(502);
    expect(((await first.json()) as any).error.type).toBe("checkout_unavailable");

    const retry = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(retry.status).toBe(409);
    expect(((await retry.json()) as any).error.type).toBe("billing_checkout_pending");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases an expired unrecorded subscription checkout reservation when Paddle has no matching transaction", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const releaseBodies: Array<{ reservationId?: string }> = [];
    let pendingReservation:
      | {
          reservationId: string;
          createdAt: number;
          expiresAt: number;
          priceId: string;
          quantity: number;
        }
      | undefined = {
      reservationId: "checkout-lost",
      createdAt: MON,
      expiresAt: MON + RESERVATION_TTL_MS,
      priceId: PRO_PRICE,
      quantity: 1,
    };
    const quotaStub = {
      fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestUrl(input).replace("https://account-quota.internal", "");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (path === "/paddle-subscription-checkout-reserve") {
          if (pendingReservation) {
            return Promise.resolve(
              Response.json({ pending: true, checkoutUrl: null, ...pendingReservation }),
            );
          }
          return Promise.resolve(
            Response.json({ reserved: true, reservationId: body.reservationId }),
          );
        }
        if (path === "/paddle-subscription-checkout-release") {
          releaseBodies.push(body);
          if (pendingReservation?.reservationId === body.reservationId) {
            pendingReservation = undefined;
          }
          return Promise.resolve(Response.json({ released: true }));
        }
        if (path === "/paddle-subscription-checkout-record") {
          return Promise.resolve(Response.json({ recorded: true }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    };
    const quotaEnv: Env = {
      ...paddleEnv,
      ACCOUNT_QUOTA: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => quotaStub as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("https://sandbox-api.paddle.com/transactions?")) {
        return Promise.resolve(
          Response.json({ data: [], meta: { pagination: { has_more: false, next: null } } }),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_retry",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_retry" },
              },
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      quotaEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: "txn_retry",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_retry",
    });
    expect(releaseBodies).toEqual([{ reservationId: "checkout-lost" }]);
    const transactionLookups = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).startsWith("https://sandbox-api.paddle.com/transactions?"),
    );
    const transactionCreates = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === "https://sandbox-api.paddle.com/transactions" &&
        init?.method === "POST",
    );
    expect(transactionLookups).toHaveLength(1);
    const lookupParams = new URL(requestUrl(transactionLookups[0][0])).searchParams;
    expect(lookupParams.get("origin")).toBe("api");
    expect(lookupParams.get("created_at[LTE]")).toBe(
      new Date(MON + RESERVATION_TTL_MS + 60_000).toISOString(),
    );
    expect(transactionCreates).toHaveLength(1);
  });

  it("recovers an expired unrecorded subscription checkout reservation after multiple Paddle pages", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const customData = await buildPaddleCheckoutCustomData("user_123", paddleEnv, "checkout-lost");
    const recordBodies: Array<{ reservationId?: string; transactionId?: string }> = [];
    let pendingReservation:
      | {
          reservationId: string;
          createdAt: number;
          expiresAt: number;
          priceId: string;
          quantity: number;
        }
      | undefined = {
      reservationId: "checkout-lost",
      createdAt: MON,
      expiresAt: MON + RESERVATION_TTL_MS,
      priceId: PRO_PRICE,
      quantity: 1,
    };
    const quotaStub = {
      fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestUrl(input).replace("https://account-quota.internal", "");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (path === "/paddle-subscription-checkout-reserve") {
          if (pendingReservation) {
            return Promise.resolve(
              Response.json({ pending: true, checkoutUrl: null, ...pendingReservation }),
            );
          }
          return Promise.resolve(
            Response.json({ reserved: true, reservationId: body.reservationId }),
          );
        }
        if (path === "/paddle-subscription-checkout-record") {
          recordBodies.push(body);
          return Promise.resolve(Response.json({ recorded: true }));
        }
        if (path === "/paddle-subscription-checkout-release") {
          pendingReservation = undefined;
          return Promise.resolve(Response.json({ released: true }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    };
    const quotaEnv: Env = {
      ...paddleEnv,
      ACCOUNT_QUOTA: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => quotaStub as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    };
    let lookupPage = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("https://sandbox-api.paddle.com/transactions?")) {
        lookupPage += 1;
        if (lookupPage < 4) {
          return Promise.resolve(
            Response.json({
              data: [],
              meta: {
                pagination: {
                  has_more: true,
                  next: `https://sandbox-api.paddle.com/transactions?page=${lookupPage + 1}`,
                },
              },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: "txn_found",
                status: "draft",
                customer_id: null,
                custom_data: customData,
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_found" },
                items: [{ price: { id: PRO_PRICE }, quantity: 1 }],
              },
            ],
            meta: { pagination: { has_more: false, next: null } },
          }),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(new Response("should not create", { status: 500 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      quotaEnv,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: "txn_found",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_found",
    });
    expect(recordBodies).toEqual([
      {
        reservationId: "checkout-lost",
        transactionId: "txn_found",
        checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_found",
        priceId: PRO_PRICE,
        quantity: 1,
      },
    ]);
    const transactionCreates = fetchMock.mock.calls.filter(
      ([input, init]) =>
        requestUrl(input) === "https://sandbox-api.paddle.com/transactions" &&
        init?.method === "POST",
    );
    const transactionLookups = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).startsWith("https://sandbox-api.paddle.com/transactions?"),
    );
    expect(transactionLookups).toHaveLength(4);
    expect(transactionCreates).toHaveLength(0);
  });

  it("releases a subscription checkout reservation when Paddle rejects creation", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "txn_retry",
              checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_retry" },
            },
          }),
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );
    expect(first.status).toBe(502);
    expect(((await first.json()) as any).error.type).toBe("checkout_unavailable");

    const retry = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      transactionId: "txn_retry",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects subscription checkout when a Paddle subscription is already active", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      paddleEnv,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_active");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects overage checkout until an active account has a bound Paddle customer", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { plan: "pro", status: "active", paddleSubscriptionId: "sub_123" },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: OVERAGE_PRICE }),
      }),
      paddleEnv,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_customer_not_bound");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates overage checkout for the stored Paddle customer", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
      }),
    );
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              id: "txn_overage",
              checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_overage" },
            },
          }),
          { status: 201 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: OVERAGE_PRICE, quantity: 3 }),
      }),
      paddleEnv,
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, any>;
    expect(body).toMatchObject({
      collection_mode: "automatic",
      customer_id: "ctm_123",
      items: [{ price_id: OVERAGE_PRICE, quantity: 3 }],
      checkout: { url: null },
    });
    expect(body.custom_data.sentwiseCheckoutReservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName("user_123"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        await state.storage.get(PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY),
      ).toMatchObject({
        transactionId: "txn_overage",
        priceId: OVERAGE_PRICE,
        quantity: 3,
        extraDrafts: 3,
        customerId: "ctm_123",
      });
    });
  });

  it("rejects explicitly invalid checkout quantities", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const quantity of [0, -1, 1.5, "3", null]) {
      const res = await worker.fetch(
        req("/v1/paddle/checkout", {
          method: "POST",
          headers: bearer(),
          body: JSON.stringify({ priceId: OVERAGE_PRICE, quantity }),
        }),
        paddleEnv,
      );

      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.type).toBe("invalid_request");
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported checkout prices before calling Paddle", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: "pri_attacker" }),
      }),
      paddleEnv,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /v1/paddle/change-plan (90 — in-app plan change)", () => {
  const paddleEnv: Env = {
    ...env,
    PADDLE_API_KEY: "pdl_apikey",
    PADDLE_API_BASE: "https://sandbox-api.paddle.com",
  };

  function changePlanReq(priceId: unknown): Request {
    return req("/v1/paddle/change-plan", {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ priceId }),
    });
  }

  function paddleSubscriptionOk(priceId: string, status = "active") {
    return new Response(JSON.stringify({ data: { status, items: [{ price: { id: priceId } }] } }), {
      status: 200,
    });
  }

  function lastMetadataWrite(): any {
    const calls = mocks.updateUserMetadata.mock.calls;
    return calls[calls.length - 1][1];
  }

  it("upgrades an active subscription to a higher tier with immediate proration", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "active",
          paddleSubscriptionId: "sub_123",
          priceId: STARTER_PRICE,
          paddleCustomerId: "ctm_1",
          lastEventId: "evt_old",
          updatedAt: "2024-01-01T00:00:00.000Z",
          paddleOccurredAt: "2024-01-01T00:00:00.000000Z",
        },
        quota: { weeklyDraftLimit: 30 },
      }),
    );
    mocks.updateUserMetadata.mockResolvedValue({});
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(PRO_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plan: "pro", status: "active" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    // PATCHes the subscription with the new price at qty 1 + immediate proration.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox-api.paddle.com/subscriptions/sub_123");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer pdl_apikey");
    expect(JSON.parse(init.body as string)).toEqual({
      proration_billing_mode: "prorated_immediately",
      items: [{ price_id: PRO_PRICE, quantity: 1 }],
    });

    // Optimistic entitlement write: new plan/price + PRO weekly limit, preserving
    // reconciliation/idempotency fields for the subscription.updated webhook.
    const write = lastMetadataWrite();
    expect(write.privateMetadata.subscription.plan).toBe("pro");
    expect(write.privateMetadata.subscription.priceId).toBe(PRO_PRICE);
    expect(write.privateMetadata.subscription.lastEventId).toBe("evt_old");
    expect(write.privateMetadata.subscription.paddleSubscriptionId).toBe("sub_123");
    expect(write.privateMetadata.subscription.updatedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(write.privateMetadata.subscription.paddleOccurredAt).toBe("2024-01-01T00:00:00.000000Z");
    expect(write.privateMetadata.quota.weeklyDraftLimit).toBe(120);
  });

  it("re-reads metadata inside the serialized entitlement write", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    let reads = 0;
    mocks.getUser.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(
        userWith(
          reads === 1
            ? {
                subscription: {
                  plan: "starter",
                  status: "active",
                  paddleSubscriptionId: "sub_123",
                  priceId: STARTER_PRICE,
                  lastEventId: "evt_old",
                  updatedAt: "2026-09-08T17:00:00.000Z",
                  paddleOccurredAt: "2026-09-08T17:00:00.000000Z",
                },
                quota: { weeklyDraftLimit: 30, extraDrafts: 1 },
              }
            : {
                subscription: {
                  plan: "starter",
                  status: "active",
                  paddleSubscriptionId: "sub_123",
                  priceId: STARTER_PRICE,
                  lastEventId: "evt_old",
                  updatedAt: "2026-09-08T17:00:00.000Z",
                  paddleOccurredAt: "2026-09-08T17:00:00.000000Z",
                },
                quota: {
                  weeklyDraftLimit: 30,
                  extraDrafts: 5,
                  extraDraftsWindowStart: MON,
                  lastOverageEventId: "evt_overage",
                },
              },
        ),
      );
    });
    mocks.updateUserMetadata.mockResolvedValue({});
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(PRO_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(200);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    const write = lastMetadataWrite();
    expect(write.privateMetadata.subscription).toMatchObject({
      plan: "pro",
      priceId: PRO_PRICE,
      lastEventId: "evt_old",
      updatedAt: "2026-09-08T17:00:00.000Z",
      paddleOccurredAt: "2026-09-08T17:00:00.000000Z",
    });
    expect(write.privateMetadata.quota).toMatchObject({
      weeklyDraftLimit: 120,
      extraDrafts: 5,
      extraDraftsWindowStart: MON,
      lastOverageEventId: "evt_overage",
    });
  });

  it("keeps a concurrently canceled subscription's paid quota revoked", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "active",
            paddleSubscriptionId: "sub_123",
            priceId: STARTER_PRICE,
          },
          quota: { weeklyDraftLimit: 30 },
        }),
      )
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "canceled",
            paddleSubscriptionId: "sub_123",
            priceId: STARTER_PRICE,
          },
          quota: { weeklyDraftLimit: null, extraDrafts: 0 },
        }),
      );
    mocks.updateUserMetadata.mockResolvedValue({});
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(PRO_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plan: "pro", status: "canceled" });
    const write = lastMetadataWrite();
    expect(write.privateMetadata.subscription).toMatchObject({
      plan: "pro",
      priceId: PRO_PRICE,
      status: "canceled",
    });
    expect(write.privateMetadata.quota).toMatchObject({
      weeklyDraftLimit: null,
      extraDrafts: 0,
    });
  });

  it("does not write when the latest stored subscription changed", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "active",
            paddleSubscriptionId: "sub_old",
            priceId: STARTER_PRICE,
          },
          quota: { weeklyDraftLimit: 30 },
        }),
      )
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "active",
            paddleSubscriptionId: "sub_new",
            priceId: STARTER_PRICE,
          },
          quota: { weeklyDraftLimit: 30 },
        }),
      );
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(PRO_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_changed");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/subscriptions/sub_old",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not overwrite the same previous price when the stored subscription version changed", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "active",
            paddleSubscriptionId: "sub_123",
            priceId: STARTER_PRICE,
            lastEventId: "evt_old",
            updatedAt: "2026-09-08T17:00:00.000Z",
            paddleOccurredAt: "2026-09-08T17:00:00.000000Z",
          },
          quota: { weeklyDraftLimit: 30 },
        }),
      )
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "active",
            paddleSubscriptionId: "sub_123",
            priceId: STARTER_PRICE,
            lastEventId: "evt_newer",
            updatedAt: "2026-09-08T17:30:00.000Z",
            paddleOccurredAt: "2026-09-08T17:30:00.000000Z",
          },
          quota: { weeklyDraftLimit: 30 },
        }),
      );
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(PRO_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_changed");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/subscriptions/sub_123",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer plan on the same subscription", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "starter",
            status: "active",
            paddleSubscriptionId: "sub_123",
            priceId: STARTER_PRICE,
          },
          quota: { weeklyDraftLimit: 30 },
        }),
      )
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "unlimited",
            status: "active",
            paddleSubscriptionId: "sub_123",
            priceId: UNLIMITED_PRICE,
            lastEventId: "evt_newer",
            paddleOccurredAt: "2026-09-08T17:30:00.000000Z",
          },
          quota: { weeklyDraftLimit: 100000 },
        }),
      );
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(PRO_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_changed");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/subscriptions/sub_123",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("downgrades an active subscription to a lower tier with immediate proration", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          priceId: PRO_PRICE,
        },
        quota: { weeklyDraftLimit: 120 },
      }),
    );
    mocks.updateUserMetadata.mockResolvedValue({});
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(STARTER_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(STARTER_PRICE), paddleEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plan: "starter", status: "active" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).proration_billing_mode).toBe("prorated_immediately");
    expect(JSON.parse(init.body as string).items).toEqual([
      { price_id: STARTER_PRICE, quantity: 1 },
    ]);

    const write = lastMetadataWrite();
    expect(write.privateMetadata.subscription.plan).toBe("starter");
    expect(write.privateMetadata.quota.weeklyDraftLimit).toBe(30);
  });

  it("rejects an unknown price without touching Clerk or Paddle", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq("pri_unknown"), paddleEnv);

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing price id", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/v1/paddle/change-plan", { method: "POST", headers: bearer(), body: "{}" }),
      paddleEnv,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects switching to the plan already active (same price) as a no-op", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          priceId: PRO_PRICE,
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("404s when the account has no Paddle subscription id", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({ subscription: { plan: "trial", status: "trialing" } }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.type).toBe("billing_subscription_not_found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the Paddle plan change fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "active",
          paddleSubscriptionId: "sub_123",
          priceId: STARTER_PRICE,
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("server error", { status: 500 }))),
    );

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("subscription_change_failed");
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("rejects a Paddle plan change response with the wrong recurring price", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "active",
          paddleSubscriptionId: "sub_123",
          priceId: STARTER_PRICE,
        },
      }),
    );
    const fetchMock = vi.fn(() => Promise.resolve(paddleSubscriptionOk(STARTER_PRICE)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("subscription_change_failed");
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("rejects a Paddle plan change response without a recurring price", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "active",
          paddleSubscriptionId: "sub_123",
          priceId: STARTER_PRICE,
        },
      }),
    );
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { status: "active", items: [] } }))),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), paddleEnv);

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("subscription_change_failed");
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("503s when Paddle is not configured (no API key)", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(changePlanReq(PRO_PRICE), {
      ...env,
      PADDLE_API_KEY: undefined,
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.type).toBe("checkout_unavailable");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("405s a GET to the change-plan route", async () => {
    const res = await worker.fetch(req("/v1/paddle/change-plan", { method: "GET" }), paddleEnv);
    expect(res.status).toBe(405);
  });
});

describe("DELETE /v1/me (73 — account deletion)", () => {
  const deletePaddleEnv: Env = {
    ...env,
    PADDLE_WEBHOOK_SECRET: PADDLE_SECRET,
    PADDLE_API_KEY: "pdl_apikey",
    PADDLE_API_BASE: "https://sandbox-api.paddle.com",
    EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE,
  };

  beforeEach(() => {
    mocks.getUser.mockResolvedValue(activeTrial());
  });

  it("deletes the Clerk user and tombstones the usage DO, returning 204", async () => {
    // Seed some usage first so the wipe is observable.
    mocks.verifyToken.mockResolvedValue({ sub: "u-del" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const drafted = await worker.fetch(draftReq("u-del"), env);
    expect(drafted.status).toBe(200);
    expect(((await drafted.json()) as any).quota.used).toBe(1);

    fetchMock.mockResolvedValue(clerkDeleteResponse());
    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.clerk.com/v1/users/u-del",
      expect.objectContaining({ method: "DELETE" }),
    );

    // Stale authenticated calls after deletion cannot recreate a fresh quota window.
    mocks.getUser.mockResolvedValue(activeTrial());
    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(me.status).toBe(410);
    expect(((await me.json()) as any).error.type).toBe("account_deleted");
  });

  it("rejects account deletion while a paid Paddle subscription is active", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-paid" });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
        },
      }),
    );
    const fetchMock = vi.fn().mockResolvedValue(clerkDeleteResponse());
    vi.stubGlobal("fetch", fetchMock);

    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);

    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.type).toBe("billing_subscription_active");
    expect(fetchMock).not.toHaveBeenCalled();
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName("u-del-paid"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(ACCOUNT_DELETION_KEY)).toBeUndefined();
    });
  });

  it("cancels the deletion barrier when the post-barrier subscription recheck is paid", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-resumed" });
    mocks.getUser
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "pro",
            status: "canceled",
            paddleSubscriptionId: "sub_123",
            paddleCustomerId: "ctm_123",
          },
        }),
      )
      .mockResolvedValueOnce(
        userWith({
          subscription: {
            plan: "pro",
            status: "active",
            paddleSubscriptionId: "sub_123",
            paddleCustomerId: "ctm_123",
          },
        }),
      );
    const fetchMock = vi.fn().mockResolvedValue(clerkDeleteResponse());
    vi.stubGlobal("fetch", fetchMock);

    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);

    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.type).toBe("billing_subscription_active");
    expect(fetchMock).not.toHaveBeenCalled();
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName("u-del-resumed"));
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(ACCOUNT_DELETION_KEY)).toBeUndefined();
    });
  });

  it("rejects account deletion while a subscription checkout transaction is pending", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-pending-checkout" });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_pending_delete",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_pending_delete" },
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions/txn_pending_delete") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_pending_delete",
                status: "draft",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_pending_delete" },
                items: [{ price: { id: PRO_PRICE }, quantity: 1 }],
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const checkout = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      deletePaddleEnv,
    );
    expect(checkout.status).toBe(200);

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      deletePaddleEnv,
    );

    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.type).toBe("billing_checkout_pending");
    expect(fetchMock.mock.calls.filter(([input, init]) => isClerkDelete(input, init))).toHaveLength(
      0,
    );
  });

  it("releases an expired unrecorded subscription checkout with no Paddle match before deleting the account", async () => {
    const uid = "u-del-expired-unrecorded-checkout";
    mocks.verifyToken.mockResolvedValue({ sub: uid });
    mocks.getUser.mockResolvedValue({ ...userWith({ subscription: null }), id: uid });
    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName(uid));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY, {
        reservationId: "checkout-lost",
        createdAt: MON,
        expiresAt: MON + RESERVATION_TTL_MS,
        priceId: PRO_PRICE,
        quantity: 1,
      });
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("https://sandbox-api.paddle.com/transactions?")) {
        return Promise.resolve(
          Response.json({ data: [], meta: { pagination: { has_more: false, next: null } } }),
        );
      }
      if (isClerkDelete(input, init)) return Promise.resolve(clerkDeleteResponse());
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), {
      ...env,
      PADDLE_API_KEY: "pdl_apikey",
      PADDLE_API_BASE: "https://sandbox-api.paddle.com",
      PADDLE_WEBHOOK_SECRET: PADDLE_SECRET,
    });

    expect(del.status).toBe(204);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).startsWith("https://sandbox-api.paddle.com/transactions?"),
      ),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input, init]) => isClerkDelete(input, init))).toHaveLength(
      1,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY)).toBe(
        undefined,
      );
    });
  });

  it("rejects account deletion while an overage checkout transaction is pending", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-pending-overage-checkout" });
    const activeSubscription = userWith({
      subscription: {
        plan: "pro",
        status: "active",
        paddleSubscriptionId: "sub_123",
        paddleCustomerId: "ctm_123",
      },
    });
    const canceledSubscription = userWith({
      subscription: {
        plan: "pro",
        status: "canceled",
        paddleSubscriptionId: "sub_123",
        paddleCustomerId: "ctm_123",
      },
    });
    mocks.getUser
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValueOnce(activeSubscription)
      .mockResolvedValue(canceledSubscription);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_pending_overage_delete",
                checkout: {
                  url: "https://checkout.paddle.com/pay?_ptxn=txn_pending_overage_delete",
                },
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions/txn_pending_overage_delete") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_pending_overage_delete",
                status: "draft",
                checkout: {
                  url: "https://checkout.paddle.com/pay?_ptxn=txn_pending_overage_delete",
                },
                items: [{ price: { id: OVERAGE_PRICE }, quantity: 2 }],
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const checkout = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: OVERAGE_PRICE, quantity: 2 }),
      }),
      deletePaddleEnv,
    );
    expect(checkout.status).toBe(200);

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      deletePaddleEnv,
    );

    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.type).toBe("billing_checkout_pending");
    expect(fetchMock.mock.calls.filter(([input, init]) => isClerkDelete(input, init))).toHaveLength(
      0,
    );
  });

  it("releases a canceled subscription checkout before deleting the account", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-canceled-checkout" });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === "https://sandbox-api.paddle.com/transactions" && init?.method === "POST") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_canceled_delete",
                checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_canceled_delete" },
              },
            }),
            { status: 201 },
          ),
        );
      }
      if (url === "https://sandbox-api.paddle.com/transactions/txn_canceled_delete") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ data: { id: "txn_canceled_delete", status: "canceled" } }),
            {
              status: 200,
            },
          ),
        );
      }
      if (isClerkDelete(input, init)) return Promise.resolve(clerkDeleteResponse());
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const checkout = await worker.fetch(
      req("/v1/paddle/checkout", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: PRO_PRICE }),
      }),
      deletePaddleEnv,
    );
    expect(checkout.status).toBe(200);

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      deletePaddleEnv,
    );

    expect(del.status).toBe(204);
    expect(fetchMock.mock.calls.filter(([input, init]) => isClerkDelete(input, init))).toHaveLength(
      1,
    );
  });

  it("does not delete when begin-delete sees a checkout created after the preflight", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-checkout-race" });
    const fetchMock = vi.fn().mockResolvedValue(clerkDeleteResponse());
    vi.stubGlobal("fetch", fetchMock);
    const quotaStub = {
      fetch: vi.fn((input: RequestInfo | URL) => {
        const path = internalUrl(input).pathname;
        if (
          path === "/paddle-subscription-checkout-peek" ||
          path === "/paddle-overage-checkout-peek"
        ) {
          return Promise.resolve(Response.json({ pending: false }));
        }
        if (path === "/begin-delete") {
          return Promise.resolve(
            Response.json(
              {
                error: {
                  type: "billing_checkout_pending",
                  message:
                    "Complete or cancel your pending Paddle checkout before deleting your account.",
                },
              },
              { status: 409 },
            ),
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      }),
    };
    const quotaEnv: Env = {
      ...deletePaddleEnv,
      ACCOUNT_QUOTA: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => quotaStub as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    };

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      quotaEnv,
    );

    expect(del.status).toBe(409);
    expect(((await del.json()) as any).error.type).toBe("billing_checkout_pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is idempotent — a Clerk user already gone still returns 204", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-gone" });
    mocks.getUser.mockRejectedValueOnce({ status: 404 });
    const fetchMock = vi.fn().mockResolvedValue(clerkDeleteResponse(404));
    vi.stubGlobal("fetch", fetchMock);
    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries quota finalization after Clerk deletion succeeds", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-finalize-retry" });
    const fetchMock = vi.fn().mockResolvedValue(clerkDeleteResponse());
    vi.stubGlobal("fetch", fetchMock);
    const quota = quotaNamespaceWithDeletionFailures({ finishFailures: 1 });
    const flakyQuotaEnv: Env = { ...env, ACCOUNT_QUOTA: quota.namespace };

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      flakyQuotaEnv,
    );
    expect(del.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clerk.com/v1/users/u-del-finalize-retry",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(quota.finishCalls()).toBe(2);
  });

  it("preserves usage and cancels the deletion barrier when Clerk deletion fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-fail" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const drafted = await worker.fetch(draftReq("u-del-fail"), env);
    expect(drafted.status).toBe(200);
    expect(((await drafted.json()) as any).quota.used).toBe(1);

    fetchMock.mockResolvedValue(clerkDeleteResponse(500));
    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(502);
    const body = (await del.json()) as any;
    expect(body.error.type).toBe("account_deletion_failed");
    expect(body.error.message).not.toContain("secret-ish");
    expect(body.error.message).not.toContain("clerk exploded");

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).quota.used).toBe(1);
  });

  it("retries deletion barrier cancellation when Clerk deletion fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-cancel-retry" });
    mocks.getUser.mockResolvedValue(activeTrial());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(clerkDeleteResponse(500)));
    const quota = quotaNamespaceWithDeletionFailures({ cancelFailures: 1 });
    const flakyQuotaEnv: Env = { ...env, ACCOUNT_QUOTA: quota.namespace };

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      flakyQuotaEnv,
    );
    expect(del.status).toBe(502);
    expect(((await del.json()) as any).error.type).toBe("account_deletion_failed");
    expect(quota.cancelCalls()).toBe(2);

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), flakyQuotaEnv);
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).quota.used).toBe(1);
  });

  it("surfaces deletion barrier cancellation failure instead of swallowing it", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-cancel-fail" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(clerkDeleteResponse(500)));
    const quota = quotaNamespaceWithDeletionFailures({ cancelFailures: 2 });
    const flakyQuotaEnv: Env = { ...env, ACCOUNT_QUOTA: quota.namespace };

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      flakyQuotaEnv,
    );
    expect(del.status).toBe(503);
    expect(((await del.json()) as any).error.type).toBe("account_deletion_recovery_failed");
    expect(quota.cancelCalls()).toBe(2);
  });

  it("surfaces deletion barrier cancellation mismatch when the DO leaves the barrier active", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-cancel-mismatch" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(clerkDeleteResponse(500)));
    const quota = quotaNamespaceWithDeletionFailures({ cancelMismatch: true });
    const flakyQuotaEnv: Env = { ...env, ACCOUNT_QUOTA: quota.namespace };

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      flakyQuotaEnv,
    );

    expect(del.status).toBe(503);
    expect(((await del.json()) as any).error.type).toBe("account_deletion_recovery_failed");
    expect(quota.cancelCalls()).toBe(2);
  });

  it("keeps the deletion barrier when Clerk deletion times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00.000Z"));
    try {
      const deleteStarted = deferred<void>();
      mocks.verifyToken.mockResolvedValue({ sub: "u-del-timeout" });
      mocks.getUser.mockResolvedValue(activeTrial());
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          deleteStarted.resolve();
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              return;
            }
            signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          });
        }),
      );

      const deletion = worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
      await deleteStarted.promise;
      await vi.advanceTimersByTimeAsync(CLERK_DELETE_TIMEOUT_MS);
      const res = await deletion;

      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.type).toBe("account_deletion_status_unknown");
      const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
      expect(me.status).toBe(409);
      expect(((await me.json()) as any).error.type).toBe("account_deletion_in_progress");
      await clearAccountDeletionState("u-del-timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the deletion barrier when Clerk delete has a transport failure", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-transport-fail" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network failed"));
    vi.stubGlobal("fetch", fetchMock);

    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);

    expect(del.status).toBe(503);
    expect(((await del.json()) as any).error.type).toBe("account_deletion_status_unknown");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clerk.com/v1/users/u-del-transport-fail",
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    );

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(me.status).toBe(409);
    expect(((await me.json()) as any).error.type).toBe("account_deletion_in_progress");
    await clearAccountDeletionState("u-del-transport-fail");
  });

  it("blocks an authenticated draft from settling after deletion starts", async () => {
    const started = deferred<void>();
    const upstream = deferred<Response>();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (isClerkDelete(input, init)) return Promise.resolve(clerkDeleteResponse());
      if (isClerkUserLookup(input, init)) return Promise.resolve(clerkDeleteResponse());
      started.resolve();
      return upstream.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(activeTrial());

    const draft = worker.fetch(draftReq("u-del-race"), env);
    await started.promise;

    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(204);

    upstream.resolve(anthropicOk("late"));
    const completedDraft = await draft;
    expect(completedDraft.status).toBe(410);
    expect(((await completedDraft.json()) as any).error.type).toBe("account_deleted");
    const calls = fetchMock.mock.calls;
    expect(calls.filter(([input, init]) => isClerkDelete(input, init))).toHaveLength(1);
    expect(
      calls.filter(
        ([input, init]) =>
          requestUrl(input).startsWith("https://api.anthropic.com/") && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("defers a settlement blocked by a deletion that is later canceled", async () => {
    const started = deferred<void>();
    const upstream = deferred<Response>();
    const clerkDelete = deferred<Response>();
    const deleteStarted = deferred<void>();
    const analytics = usageAnalytics();
    const analyticsEnv: Env = { ...env, USAGE_ANALYTICS: analytics.dataset };
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (isClerkDelete(input, init)) {
        deleteStarted.resolve();
        return clerkDelete.promise;
      }
      if (isClerkUserLookup(input, init)) return Promise.resolve(clerkDeleteResponse());
      started.resolve();
      return upstream.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(activeTrial());

    const draft = worker.fetch(draftReq("u-del-settle-cancel"), analyticsEnv);
    await started.promise;
    const deletion = worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      analyticsEnv,
    );
    await deleteStarted.promise;

    upstream.resolve(anthropicOk("late"));
    const completedDraft = await draft;
    expect(completedDraft.status).toBe(409);
    expect(((await completedDraft.json()) as any).error.type).toBe("account_deletion_in_progress");
    expect(analytics.writeDataPoint).toHaveBeenCalledOnce();
    const dataPoint = analytics.writeDataPoint.mock.calls[0][0] as {
      blobs: string[];
      doubles: number[];
    };
    expect(dataPoint.blobs[2]).toBe("ok");
    expect(dataPoint.doubles[0]).toBe(3);
    expect(dataPoint.doubles[1]).toBe(2);

    clerkDelete.resolve(clerkDeleteResponse(500));
    const failedDeletion = await deletion;
    expect(failedDeletion.status).toBe(502);

    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName("u-del-settle-cancel"));
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), analyticsEnv);
    const quota = ((await me.json()) as any).quota;
    expect(quota.used).toBe(1);
    expect(quota.tokensUsed).toBe(5);
  });

  it("defers a release blocked by a deletion that is later canceled", async () => {
    const started = deferred<void>();
    const upstream = deferred<Response>();
    const clerkDelete = deferred<Response>();
    const deleteStarted = deferred<void>();
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (isClerkDelete(input, init)) {
        deleteStarted.resolve();
        return clerkDelete.promise;
      }
      if (isClerkUserLookup(input, init)) return Promise.resolve(clerkDeleteResponse());
      started.resolve();
      return upstream.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(activeTrial());

    const draft = worker.fetch(draftReq("u-del-release-cancel"), env);
    await started.promise;
    const deletion = worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    await deleteStarted.promise;

    upstream.resolve(
      new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
    );
    const failedDraft = await draft;
    expect(failedDraft.status).toBe(503);
    expect(((await failedDraft.json()) as any).error.type).toBe("overloaded");

    clerkDelete.resolve(clerkDeleteResponse(500));
    const failedDeletion = await deletion;
    expect(failedDeletion.status).toBe(502);

    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName("u-del-release-cancel"));
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const quota = ((await me.json()) as any).quota;
    expect(quota.used).toBe(0);
    expect(quota.tokensUsed).toBe(0);
  });

  it("rejects an unauthenticated delete with 401 and never touches Clerk", async () => {
    const del = await worker.fetch(req("/v1/me", { method: "DELETE" }), env);
    expect(del.status).toBe(401);
    expect(((await del.json()) as any).error.type).toBe("unauthenticated");
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it("405s a wrong method on /v1/me (e.g. POST) while GET and DELETE work", async () => {
    const res = await worker.fetch(req("/v1/me", { method: "POST", headers: bearer() }), env);
    expect(res.status).toBe(405);
    expect(((await res.json()) as any).error.type).toBe("method_not_allowed");
  });
});

describe("routing", () => {
  it("405s a known path with the wrong method", async () => {
    const res = await worker.fetch(req("/v1/draft", { method: "GET" }), env);
    expect(res.status).toBe(405);
  });
  it("keeps /admin/margin invisible for wrong methods when ADMIN_TOKEN is unset", async () => {
    const res = await worker.fetch(req("/admin/margin", { method: "POST" }), {
      ...env,
      ADMIN_TOKEN: undefined,
    });
    expect(res.status).toBe(404);
  });
  it("405s /admin/margin wrong methods only when ADMIN_TOKEN is configured", async () => {
    const res = await worker.fetch(req("/admin/margin", { method: "POST" }), {
      ...env,
      ADMIN_TOKEN: "correct-token",
    });
    expect(res.status).toBe(405);
  });
  it("404s an unknown path", async () => {
    const res = await worker.fetch(req("/nope"), env);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 75 — POST /v1/interest demand capture (first click wins; content-free).
// ---------------------------------------------------------------------------
describe("POST /v1/interest (75 — demand capture)", () => {
  function interestReq(body: string, headers: HeadersInit = bearer()): Request {
    return req("/v1/interest", { method: "POST", headers, body });
  }

  it("records first interest and returns 204", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockResolvedValue(undefined);

    const before = Date.now();
    const res = await worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    expect(mocks.updateUserMetadata).toHaveBeenCalledOnce();
    const arg = mocks.updateUserMetadata.mock.calls[0][1];
    const ts = arg.privateMetadata.interest["google-oauth"];
    expect(typeof ts).toBe("string");
    expect(Date.parse(ts)).toBeGreaterThanOrEqual(before);
  });

  it("does not overwrite an existing timestamp on a second call (first click wins)", async () => {
    const firstTs = "2026-08-01T00:00:00.000Z";
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({ interest: { "google-oauth": firstTs } }));
    mocks.updateUserMetadata.mockResolvedValue(undefined);

    const res = await worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    expect(res.status).toBe(204);
    // Idempotent: no write happens, so the original timestamp is preserved.
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("serializes overlapping writes so the first timestamp wins", async () => {
    let privateMetadata: Record<string, unknown> = {};
    const firstWrite = deferred<void>();
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(privateMetadata)));
    mocks.updateUserMetadata.mockImplementation(async (_userId, update) => {
      await firstWrite.promise;
      privateMetadata = { ...privateMetadata, ...update.privateMetadata };
    });

    const first = worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    await vi.waitFor(() => expect(mocks.updateUserMetadata).toHaveBeenCalledOnce());

    const second = worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    await vi.waitFor(() => expect(mocks.verifyToken).toHaveBeenCalledTimes(2));

    expect(mocks.getUser).toHaveBeenCalledOnce();
    expect(mocks.updateUserMetadata).toHaveBeenCalledOnce();

    firstWrite.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.status).toBe(204);
    expect(secondRes.status).toBe(204);
    expect(mocks.getUser).toHaveBeenCalledTimes(2);
    expect(mocks.updateUserMetadata).toHaveBeenCalledOnce();
    expect((privateMetadata.interest as Record<string, unknown>)["google-oauth"]).toBe(
      mocks.updateUserMetadata.mock.calls[0][1].privateMetadata.interest["google-oauth"],
    );
  });

  it("preserves unrelated privateMetadata keys and existing interest topics", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(
      userWith({
        trialStartedAt: "2026-08-01T00:00:00.000Z",
        quota: { weeklyDrafts: 500 },
        subscription: { plan: "individual" },
        interest: { "some-legacy-topic": "2026-07-01T00:00:00.000Z" },
      }),
    );
    mocks.updateUserMetadata.mockResolvedValue(undefined);

    const res = await worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    expect(res.status).toBe(204);

    const arg = mocks.updateUserMetadata.mock.calls[0][1];
    // Top-level write carries ONLY `interest` — Clerk shallow-merges, so trial,
    // quota, and subscription keys are left untouched (mirrors trialStartedAt).
    expect(Object.keys(arg.privateMetadata)).toEqual(["interest"]);
    // Within `interest`, the pre-existing topic is preserved alongside the new one.
    expect(arg.privateMetadata.interest["some-legacy-topic"]).toBe("2026-07-01T00:00:00.000Z");
    expect(typeof arg.privateMetadata.interest["google-oauth"]).toBe("string");
  });

  it("400s an unknown topic without touching Clerk", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const res = await worker.fetch(interestReq(JSON.stringify({ topic: "slack-approvals" })), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("400s a missing topic", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const res = await worker.fetch(interestReq(JSON.stringify({})), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("400s malformed JSON", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    const res = await worker.fetch(interestReq("{not json"), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.type).toBe("invalid_request");
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated request without touching Clerk", async () => {
    const res = await worker.fetch(
      req("/v1/interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: "google-oauth" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.type).toBe("unauthenticated");
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });

  it("405s a wrong method (GET)", async () => {
    const res = await worker.fetch(req("/v1/interest", { method: "GET", headers: bearer() }), env);
    expect(res.status).toBe(405);
    expect(((await res.json()) as any).error.type).toBe("method_not_allowed");
  });

  it("502s interest_failed when the Clerk lookup fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockRejectedValue(new Error("clerk down"));
    const res = await worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("interest_failed");
  });

  it("502s interest_failed when the Clerk write fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_123" });
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockRejectedValue(new Error("clerk write down"));
    const res = await worker.fetch(interestReq(JSON.stringify({ topic: "google-oauth" })), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("interest_failed");
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
        quota: { extraDrafts: 5, extraDraftsWindowStart: mondayStartUtc(Date.now()) },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));

    const res = await worker.fetch(draftReq("u-extra"), env);
    const q = ((await res.json()) as any).quota;
    expect(q.limit).toBe(105);
    expect(q.extraPurchased).toBe(5);
    expect(q.remaining).toBe(104);
  });

  it("ignores stale purchased extras from a previous weekly window", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-extra-stale" });
    mocks.getUser.mockResolvedValue(
      userWith({
        trialStartedAt: new Date(Date.now() - 1000).toISOString(),
        quota: { extraDrafts: 5, extraDraftsWindowStart: mondayStartUtc(Date.now()) - WEEK_MS },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));

    const res = await worker.fetch(draftReq("u-extra-stale"), env);
    const q = ((await res.json()) as any).quota;
    expect(q.limit).toBe(100);
    expect(q.extraPurchased).toBe(0);
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
    // maxTokensPerRequest = 10; even a tiny request (UTF-8 bytes + DEFAULT_MAX_TOKENS) exceeds it.
    const capEnv: Env = { ...env, MAX_TOKENS_PER_REQUEST: "10" };

    const res = await worker.fetch(draftReq("u-big"), capEnv);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.type).toBe("request_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the conservative byte bound for the always-hard request safety cap", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-byte-cap" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const capEnv: Env = { ...env, MAX_TOKENS_PER_REQUEST: "20" };

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          maxTokens: 1,
          messages: [{ role: "user", content: "漢字漢字漢字漢字" }],
        }),
      }),
      capEnv,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.type).toBe("request_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes message framing in the always-hard request safety cap", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-frame-cap" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const capEnv: Env = { ...env, MAX_TOKENS_PER_REQUEST: "100" };

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          maxTokens: 1,
          messages: Array.from({ length: 7 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: "x",
          })),
        }),
      }),
      capEnv,
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.type).toBe("request_too_large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("releases a reserved draft when Anthropic fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-upstream-fail-release" });
    mocks.getUser.mockResolvedValue(activeTrial());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { type: "overloaded_error" } }), { status: 529 }),
        ),
    );

    const failed = await worker.fetch(draftReq("u-upstream-fail-release"), env);
    expect(failed.status).toBe(503);

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const q = ((await me.json()) as any).quota;
    expect(q.used).toBe(0);
  });

  it("hard enforcement reserves a conservative byte bound for multibyte input", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-hard-token-reserve" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const hardEnv: Env = { ...env, WEEKLY_TOKEN_LIMIT: "20", ENFORCEMENT_MODE: "hard" };

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          maxTokens: 1,
          messages: [{ role: "user", content: "漢字漢字漢字漢字" }],
        }),
      }),
      hardEnv,
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error.type).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hard enforcement reserves message framing capacity", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-hard-frame-reserve" });
    mocks.getUser.mockResolvedValue(activeTrial());
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const hardEnv: Env = { ...env, WEEKLY_TOKEN_LIMIT: "100", ENFORCEMENT_MODE: "hard" };

    const res = await worker.fetch(
      req("/v1/draft", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({
          maxTokens: 1,
          messages: Array.from({ length: 7 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: "x",
          })),
        }),
      }),
      hardEnv,
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error.type).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a completed draft response when quota settlement fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-settle-fail" });
    mocks.getUser.mockResolvedValue(activeTrial());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));
    const quota = quotaNamespaceWithSettleFailure(Date.now());
    const flakyQuotaEnv: Env = { ...env, ACCOUNT_QUOTA: quota.namespace };

    const res = await worker.fetch(draftReq("u-settle-fail"), flakyQuotaEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.text).toBe("ok");
    expect(body.quota.used).toBe(1);
    expect(body.quota.tokensUsed).toBe(5);
    expect(body.quota.remaining).toBe(99);
    expect(quota.settleCalls()).toBe(2);
    expect(quota.deferCalls()).toBe(1);
    expect(quota.deferredSettlements()[0]).toMatchObject({
      reservationWindowStart: expect.any(Number),
      estimatedTokens: expect.any(Number),
      tokensDelta: 5,
    });
    expect(typeof quota.deferredSettlements()[0].reservationId).toBe("string");
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
