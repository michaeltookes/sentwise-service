import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import { TRIAL_MS } from "../src/config";
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

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.verifyToken.mockReset();
  mocks.getUser.mockReset();
  mocks.updateUserMetadata.mockReset();
  mocks.deleteUser.mockReset();
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

  it("uses a valid privateMetadata.subscription override verbatim", async () => {
    const override = {
      plan: "individual",
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
    expect(body.subscription).toEqual(override);
  });
});

describe("DELETE /v1/me (73 — account deletion)", () => {
  it("deletes the Clerk user and tombstones the usage DO, returning 204", async () => {
    // Seed some usage first so the wipe is observable.
    mocks.verifyToken.mockResolvedValue({ sub: "u-del" });
    mocks.getUser.mockResolvedValue(activeTrial());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));
    const drafted = await worker.fetch(draftReq("u-del"), env);
    expect(drafted.status).toBe(200);
    expect(((await drafted.json()) as any).quota.used).toBe(1);

    mocks.deleteUser.mockResolvedValue(undefined);
    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect(mocks.deleteUser).toHaveBeenCalledWith("u-del");

    // Stale authenticated calls after deletion cannot recreate a fresh quota window.
    mocks.getUser.mockResolvedValue(activeTrial());
    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    expect(me.status).toBe(410);
    expect(((await me.json()) as any).error.type).toBe("account_deleted");
  });

  it("is idempotent — a Clerk user already gone still returns 204", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-gone" });
    mocks.deleteUser.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(204);
    expect(mocks.deleteUser).toHaveBeenCalledOnce();
  });

  it("retries quota finalization after Clerk deletion succeeds", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-finalize-retry" });
    mocks.deleteUser.mockResolvedValue(undefined);
    const quota = quotaNamespaceWithDeletionFailures({ finishFailures: 1 });
    const flakyQuotaEnv: Env = { ...env, ACCOUNT_QUOTA: quota.namespace };

    const del = await worker.fetch(
      req("/v1/me", { method: "DELETE", headers: bearer() }),
      flakyQuotaEnv,
    );
    expect(del.status).toBe(204);
    expect(mocks.deleteUser).toHaveBeenCalledWith("u-del-finalize-retry");
    expect(quota.finishCalls()).toBe(2);
  });

  it("preserves usage and cancels the deletion barrier when Clerk deletion fails", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "u-del-fail" });
    mocks.getUser.mockResolvedValue(activeTrial());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(anthropicOk("ok")));
    const drafted = await worker.fetch(draftReq("u-del-fail"), env);
    expect(drafted.status).toBe(200);
    expect(((await drafted.json()) as any).quota.used).toBe(1);

    mocks.deleteUser.mockRejectedValue(
      Object.assign(new Error("clerk exploded: secret-ish detail"), { status: 500 }),
    );
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
    mocks.deleteUser.mockRejectedValue(Object.assign(new Error("clerk failed"), { status: 500 }));
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
    mocks.deleteUser.mockRejectedValue(Object.assign(new Error("clerk failed"), { status: 500 }));
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
    mocks.deleteUser.mockRejectedValue(Object.assign(new Error("clerk failed"), { status: 500 }));
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

  it("blocks an authenticated draft from settling after deletion starts", async () => {
    const started = deferred<void>();
    const upstream = deferred<Response>();
    const fetchMock = vi.fn().mockImplementation(() => {
      started.resolve();
      return upstream.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(activeTrial());
    mocks.deleteUser.mockResolvedValue(undefined);

    const draft = worker.fetch(draftReq("u-del-race"), env);
    await started.promise;

    const del = await worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    expect(del.status).toBe(204);

    upstream.resolve(anthropicOk("late"));
    const completedDraft = await draft;
    expect(completedDraft.status).toBe(410);
    expect(((await completedDraft.json()) as any).error.type).toBe("account_deleted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("defers a settlement blocked by a deletion that is later canceled", async () => {
    const started = deferred<void>();
    const upstream = deferred<Response>();
    const fetchMock = vi.fn().mockImplementation(() => {
      started.resolve();
      return upstream.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const clerkDelete = deferred<void>();
    const deleteStarted = deferred<void>();
    mocks.getUser.mockResolvedValue(activeTrial());
    mocks.deleteUser.mockImplementation(() => {
      deleteStarted.resolve();
      return clerkDelete.promise;
    });

    const draft = worker.fetch(draftReq("u-del-settle-cancel"), env);
    await started.promise;
    const deletion = worker.fetch(req("/v1/me", { method: "DELETE", headers: bearer() }), env);
    await deleteStarted.promise;

    upstream.resolve(anthropicOk("late"));
    const completedDraft = await draft;
    expect(completedDraft.status).toBe(409);
    expect(((await completedDraft.json()) as any).error.type).toBe("account_deletion_in_progress");

    clerkDelete.reject(Object.assign(new Error("clerk failed"), { status: 500 }));
    const failedDeletion = await deletion;
    expect(failedDeletion.status).toBe(502);

    const stub = env.ACCOUNT_QUOTA.get(env.ACCOUNT_QUOTA.idFromName("u-del-settle-cancel"));
    await runInDurableObject(stub, async (instance) => {
      await (instance as { alarm: () => Promise<void> }).alarm();
    });

    const me = await worker.fetch(req("/v1/me", { headers: bearer() }), env);
    const quota = ((await me.json()) as any).quota;
    expect(quota.used).toBe(1);
    expect(quota.tokensUsed).toBe(5);
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
