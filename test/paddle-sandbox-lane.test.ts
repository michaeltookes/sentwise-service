// 123 — Paddle sandbox lane: PADDLE_ENV selects base/secret/prices, only
// @prowlqa.dev accounts may use the sandbox, and each webhook destination is
// verified with its own lane's secret only.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import { PADDLE_LIVE_API_BASE, PADDLE_SANDBOX_API_BASE } from "../src/config";
import { computeHmacSha256Hex } from "../src/paddle";

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
  getUserList: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  verifyToken: mocks.verifyToken,
  createClerkClient: () => ({
    users: {
      getUser: mocks.getUser,
      updateUserMetadata: mocks.updateUserMetadata,
      getUserList: mocks.getUserList,
    },
  }),
}));

import worker from "../src/index";
import { __resetClerkUserCache } from "../src/clerk-user-cache";
import {
  configuredPaddleEnv,
  isQaAccountEmail,
  PADDLE_LANE_HEADER,
  paddleClientConfig,
  paddleEnvForLane,
  paddleEnvForStoredLane,
  paddleLaneForEmail,
  paddleLaneFromHeader,
  sandboxLaneComplete,
  sandboxLaneEnabled,
  storedPaddleLane,
} from "../src/paddle-env";
import { quotaPeek } from "../src/quota-client";
import {
  PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY,
  PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY,
} from "../src/quota-do";

const LIVE_SECRET = "pdl_ntfset_live_test";
const SANDBOX_SECRET = "pdl_ntfset_sandbox_test";
const LIVE_KEY = "pdl_live_apikey_test";
const SANDBOX_KEY = "pdl_sdbx_apikey_test";
const LIVE_PRICES = { starter: "pri_live_starter", pro: "pri_live_pro", unlimited: "pri_live_unl" };
// The sandbox lane uses the legacy sandbox ids so the Durable Object (whose
// test bindings stay legacy) maps them too.
const SANDBOX_PRICES = {
  starter: "pri_01m1syd7nfarp8pggpcnvjbgyy",
  pro: "pri_01m1symsxarc4c3jdea0ntb09w",
  unlimited: "pri_01m1syrdg05f49kz705gbzn6tz",
};
const SANDBOX_TOKEN = "test_sandbox_client_token";

const QA_EMAIL = "qa-buyer@prowlqa.dev";
const CUSTOMER_EMAIL = "marcus@example.com";

function laneEnv(mode: string | undefined): Env {
  return {
    ...testEnv,
    CLERK_SECRET_KEY: "sk_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CLERK_PUBLISHABLE_KEY: "pk_test",
    PADDLE_ENV: mode,
    PADDLE_API_BASE: PADDLE_LIVE_API_BASE,
    PADDLE_API_KEY: LIVE_KEY,
    PADDLE_WEBHOOK_SECRET: LIVE_SECRET,
    PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET: "live_previous_binding",
    PADDLE_STARTER_PRICE_ID: LIVE_PRICES.starter,
    PADDLE_PRO_PRICE_ID: LIVE_PRICES.pro,
    PADDLE_UNLIMITED_PRICE_ID: LIVE_PRICES.unlimited,
    EXTRA_DRAFTS_PRICE_ID: "pri_live_overage",
    PADDLE_SANDBOX_API_KEY: SANDBOX_KEY,
    PADDLE_SANDBOX_WEBHOOK_SECRET: SANDBOX_SECRET,
    PADDLE_SANDBOX_CLIENT_TOKEN: SANDBOX_TOKEN,
    PADDLE_SANDBOX_STARTER_PRICE_ID: SANDBOX_PRICES.starter,
    PADDLE_SANDBOX_PRO_PRICE_ID: SANDBOX_PRICES.pro,
    PADDLE_SANDBOX_UNLIMITED_PRICE_ID: SANDBOX_PRICES.unlimited,
  };
}

function userWithEmail(email: string, privateMetadata: Record<string, unknown> = {}) {
  return {
    id: "user_lane",
    primaryEmailAddressId: "ema_1",
    emailAddresses: [{ id: "ema_1", emailAddress: email }],
    privateMetadata,
  };
}

function bearer(): HeadersInit {
  return { Authorization: "Bearer good-token", "content-type": "application/json" };
}

async function clearReservations(userId: string): Promise<void> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.delete(PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY);
    await state.storage.delete(PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY);
  });
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  mocks.verifyToken.mockReset();
  mocks.getUser.mockReset();
  mocks.updateUserMetadata.mockReset();
  mocks.getUserList.mockReset();
  mocks.updateUserMetadata.mockResolvedValue(undefined);
  __resetClerkUserCache();
  await clearReservations("user_lane");
});

// ---------------------------------------------------------------------------
// Pure resolution
// ---------------------------------------------------------------------------

describe("PADDLE_ENV parsing", () => {
  it("recognises sandbox and production, case/whitespace-insensitively", () => {
    expect(configuredPaddleEnv({ PADDLE_ENV: "sandbox" })).toBe("sandbox");
    expect(configuredPaddleEnv({ PADDLE_ENV: " Sandbox " })).toBe("sandbox");
    expect(configuredPaddleEnv({ PADDLE_ENV: "production" })).toBe("production");
  });

  it("treats unset or unknown values as legacy (no sandbox lane)", () => {
    for (const value of [undefined, "", "staging", "sandbox-ish", "test"]) {
      expect(configuredPaddleEnv({ PADDLE_ENV: value })).toBeNull();
      expect(sandboxLaneEnabled({ PADDLE_ENV: value })).toBe(false);
    }
  });
});

describe("isQaAccountEmail", () => {
  it("accepts only the exact QA domain", () => {
    expect(isQaAccountEmail("qa@prowlqa.dev")).toBe(true);
    expect(isQaAccountEmail(" QA+m3@ProwlQA.dev ")).toBe(true);
  });

  it("rejects look-alikes, subdomains, and non-strings", () => {
    for (const email of [
      "qa@prowlqa.dev.evil.com",
      "qa@sub.prowlqa.dev",
      "qa@notprowlqa.dev",
      "prowlqa.dev",
      "@prowlqa.dev",
      "a@b@prowlqa.dev",
      "marcus@example.com",
      "",
      null,
      undefined,
    ]) {
      expect(isQaAccountEmail(email)).toBe(false);
    }
  });
});

describe("paddleLaneForEmail (the single gate)", () => {
  it("routes a QA account to sandbox only when the service is in sandbox", () => {
    expect(paddleLaneForEmail({ PADDLE_ENV: "sandbox" }, QA_EMAIL)).toBe("sandbox");
    expect(paddleLaneForEmail({ PADDLE_ENV: "production" }, QA_EMAIL)).toBe("production");
    expect(paddleLaneForEmail({}, QA_EMAIL)).toBe("production");
  });

  it("never routes a production account to sandbox", () => {
    for (const mode of ["sandbox", "production", undefined]) {
      expect(paddleLaneForEmail({ PADDLE_ENV: mode }, CUSTOMER_EMAIL)).toBe("production");
      expect(paddleLaneForEmail({ PADDLE_ENV: mode }, null)).toBe("production");
    }
  });
});

describe("paddleEnvForLane", () => {
  it("sandbox lane replaces every Paddle credential and price with sandbox values", () => {
    const resolved = paddleEnvForLane(laneEnv("sandbox"), "sandbox");
    expect(resolved.PADDLE_LANE).toBe("sandbox");
    expect(resolved.PADDLE_API_BASE).toBe(PADDLE_SANDBOX_API_BASE);
    expect(resolved.PADDLE_API_KEY).toBe(SANDBOX_KEY);
    expect(resolved.PADDLE_WEBHOOK_SECRET).toBe(SANDBOX_SECRET);
    expect(resolved.PADDLE_CHECKOUT_BINDING_SECRET).toBeUndefined();
    expect(resolved.PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET).toBeUndefined();
    expect(resolved.PADDLE_STARTER_PRICE_ID).toBe(SANDBOX_PRICES.starter);
    expect(resolved.PADDLE_PRO_PRICE_ID).toBe(SANDBOX_PRICES.pro);
    expect(resolved.PADDLE_UNLIMITED_PRICE_ID).toBe(SANDBOX_PRICES.unlimited);
    expect(resolved.EXTRA_DRAFTS_PRICE_ID).toBeUndefined();
  });

  it("sandbox lane never falls back to a production key or secret", () => {
    const env = laneEnv("sandbox");
    delete env.PADDLE_SANDBOX_API_KEY;
    delete env.PADDLE_SANDBOX_WEBHOOK_SECRET;
    const resolved = paddleEnvForLane(env, "sandbox");
    expect(resolved.PADDLE_API_KEY).toBeUndefined();
    expect(resolved.PADDLE_WEBHOOK_SECRET).toBeUndefined();
  });

  it("a sandbox request is downgraded to production unless PADDLE_ENV=sandbox", () => {
    for (const mode of ["production", undefined, "staging"]) {
      const resolved = paddleEnvForLane(laneEnv(mode), "sandbox");
      expect(resolved.PADDLE_LANE).toBe("production");
      expect(resolved.PADDLE_API_KEY).toBe(LIVE_KEY);
      expect(resolved.PADDLE_WEBHOOK_SECRET).toBe(LIVE_SECRET);
    }
  });

  it("explicit production forces the live base and keeps live secrets/prices", () => {
    const env = { ...laneEnv("production"), PADDLE_API_BASE: PADDLE_SANDBOX_API_BASE };
    const resolved = paddleEnvForLane(env, "production");
    expect(resolved.PADDLE_API_BASE).toBe(PADDLE_LIVE_API_BASE);
    expect(resolved.PADDLE_API_KEY).toBe(LIVE_KEY);
    expect(resolved.PADDLE_WEBHOOK_SECRET).toBe(LIVE_SECRET);
    expect(resolved.PADDLE_PRO_PRICE_ID).toBe(LIVE_PRICES.pro);
  });

  it("production lane of a sandbox-mode Worker is still fully live", () => {
    const resolved = paddleEnvForLane(laneEnv("sandbox"), "production");
    expect(resolved.PADDLE_LANE).toBe("production");
    expect(resolved.PADDLE_API_BASE).toBe(PADDLE_LIVE_API_BASE);
    expect(resolved.PADDLE_API_KEY).toBe(LIVE_KEY);
    expect(resolved.PADDLE_PRO_PRICE_ID).toBe(LIVE_PRICES.pro);
  });

  it("legacy (unset) leaves the configured base untouched", () => {
    const env = { ...laneEnv(undefined), PADDLE_API_BASE: PADDLE_SANDBOX_API_BASE };
    expect(paddleEnvForLane(env, "production").PADDLE_API_BASE).toBe(PADDLE_SANDBOX_API_BASE);
  });
});

describe("paddleLaneFromHeader", () => {
  it("only the exact value sandbox selects the sandbox lane", () => {
    expect(paddleLaneFromHeader("sandbox")).toBe("sandbox");
    for (const v of [null, undefined, "", "Sandbox", "production", "1"]) {
      expect(paddleLaneFromHeader(v)).toBe("production");
    }
  });
});

describe("paddleClientConfig", () => {
  it("gives a QA account in sandbox mode the sandbox token and prices", () => {
    expect(paddleClientConfig(laneEnv("sandbox"), "sandbox")).toEqual({
      environment: "sandbox",
      checkoutAvailable: true,
      clientSideToken: SANDBOX_TOKEN,
      prices: SANDBOX_PRICES,
    });
  });

  it("never gives a production lane any sandbox value", () => {
    const config = paddleClientConfig(laneEnv("sandbox"), "production");
    expect(config).toEqual({ environment: "production", checkoutAvailable: true });
    expect(JSON.stringify(config)).not.toContain("test_");
  });

  it("reports production when the sandbox lane is off", () => {
    expect(paddleClientConfig(laneEnv("production"), "sandbox")).toEqual({
      environment: "production",
      checkoutAvailable: true,
    });
  });

  it("fails closed (sandbox, unavailable) when the sandbox lane is incomplete", () => {
    for (const missing of [
      "PADDLE_SANDBOX_CLIENT_TOKEN",
      "PADDLE_SANDBOX_PRO_PRICE_ID",
      "PADDLE_SANDBOX_API_KEY",
      "PADDLE_SANDBOX_WEBHOOK_SECRET",
    ] as const) {
      const incomplete = laneEnv("sandbox");
      delete incomplete[missing];
      expect(sandboxLaneComplete(incomplete)).toBe(false);
      expect(paddleClientConfig(incomplete, "sandbox"), missing).toEqual({
        environment: "sandbox",
        checkoutAvailable: false,
      });
    }
    const duplicate = {
      ...laneEnv("sandbox"),
      PADDLE_SANDBOX_PRO_PRICE_ID: SANDBOX_PRICES.starter,
    };
    expect(sandboxLaneComplete(duplicate)).toBe(false);
  });
});

describe("paddleEnvForStoredLane", () => {
  it("routes a sandbox object to the sandbox even after the lane closes", () => {
    const resolved = paddleEnvForStoredLane(laneEnv("production"), "sandbox");
    expect(resolved.PADDLE_LANE).toBe("sandbox");
    expect(resolved.PADDLE_API_BASE).toBe(PADDLE_SANDBOX_API_BASE);
    expect(resolved.PADDLE_API_KEY).toBe(SANDBOX_KEY);
  });

  it("routes a live object to live even from a sandbox lane env", () => {
    const sandbox = paddleEnvForLane(laneEnv("sandbox"), "sandbox");
    const resolved = paddleEnvForStoredLane(sandbox, "production");
    expect(resolved.PADDLE_API_BASE).toBe(PADDLE_LIVE_API_BASE);
    expect(resolved.PADDLE_API_KEY).toBe(LIVE_KEY);
    expect(resolved.PADDLE_WEBHOOK_SECRET).toBe(LIVE_SECRET);
  });

  it("reads the stored environment stamp", () => {
    expect(storedPaddleLane({ paddleEnvironment: "sandbox" })).toBe("sandbox");
    expect(storedPaddleLane({ paddleEnvironment: "production" })).toBe("production");
    expect(storedPaddleLane({})).toBe("production");
    expect(storedPaddleLane(null)).toBe("production");
  });
});

// ---------------------------------------------------------------------------
// Worker routes
// ---------------------------------------------------------------------------

describe("GET /v1/me billing lane", () => {
  it("tells a QA account to open the sandbox checkout when the service is in sandbox", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL));
    const res = await worker.fetch(
      new Request("https://sentwise-inference.test/v1/me", { headers: bearer() }),
      laneEnv("sandbox"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.billing).toEqual({
      environment: "sandbox",
      checkoutAvailable: true,
      clientSideToken: SANDBOX_TOKEN,
      prices: SANDBOX_PRICES,
    });
  });

  it("tells a production account production, even while the sandbox lane is on", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(CUSTOMER_EMAIL));
    const res = await worker.fetch(
      new Request("https://sentwise-inference.test/v1/me", { headers: bearer() }),
      laneEnv("sandbox"),
    );
    const body = (await res.json()) as any;
    expect(body.billing).toEqual({ environment: "production", checkoutAvailable: true });
    expect(JSON.stringify(body)).not.toContain(SANDBOX_TOKEN);
    expect(JSON.stringify(body)).not.toContain(SANDBOX_PRICES.pro);
  });

  it("tells a QA account production when the service is in production", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL));
    const res = await worker.fetch(
      new Request("https://sentwise-inference.test/v1/me", { headers: bearer() }),
      laneEnv("production"),
    );
    expect(((await res.json()) as any).billing).toEqual({
      environment: "production",
      checkoutAvailable: true,
    });
  });
});

function transactionCreated(): Response {
  return new Response(
    JSON.stringify({
      data: { id: "txn_lane", checkout: { url: "https://checkout.paddle.com/pay?_ptxn=txn_lane" } },
    }),
    { status: 201 },
  );
}

async function postCheckout(env: Env, priceId: string): Promise<Response> {
  return worker.fetch(
    new Request("https://sentwise-inference.test/v1/paddle/checkout", {
      method: "POST",
      headers: bearer(),
      body: JSON.stringify({ priceId }),
    }),
    env,
  );
}

describe("POST /v1/paddle/checkout lane", () => {
  it("creates a QA account's checkout on the sandbox API with the sandbox key", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(transactionCreated()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("sandbox"), SANDBOX_PRICES.pro);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      `${PADDLE_SANDBOX_API_BASE}/transactions`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${SANDBOX_KEY}` }),
      }),
    );
    for (const call of fetchMock.mock.calls) {
      const target = call[0];
      const url = typeof target === "string" || target instanceof URL ? String(target) : target.url;
      expect(url).not.toContain("://api.paddle.com");
    }
  });

  it("refuses a live price id for a QA account in the sandbox lane", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    const fetchMock = vi.fn(() => Promise.resolve(transactionCreated()));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("sandbox"), LIVE_PRICES.pro);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a production account on the live API while the sandbox lane is on", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(CUSTOMER_EMAIL, { subscription: null }));
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(transactionCreated()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("sandbox"), LIVE_PRICES.pro);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      `${PADDLE_LIVE_API_BASE}/transactions`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${LIVE_KEY}` }),
      }),
    );
  });

  it("refuses a sandbox price id for a production account", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(CUSTOMER_EMAIL, { subscription: null }));
    const fetchMock = vi.fn(() => Promise.resolve(transactionCreated()));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("sandbox"), SANDBOX_PRICES.pro);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function subscriptionEvent(priceId: string): string {
  return JSON.stringify({
    event_id: "evt_lane",
    event_type: "subscription.created",
    occurred_at: new Date().toISOString(),
    data: {
      id: "sub_lane",
      status: "active",
      customer_id: "ctm_lane",
      next_billed_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      custom_data: { clerkUserId: "user_lane" },
      items: [{ price: { id: priceId }, quantity: 1 }],
    },
  });
}

async function postWebhook(path: string, env: Env, rawBody: string, secret: string) {
  const ts = Math.floor(Date.now() / 1000);
  const h1 = await computeHmacSha256Hex(secret, `${ts}:${rawBody}`);
  return worker.fetch(
    new Request(`https://sentwise-inference.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "Paddle-Signature": `ts=${ts};h1=${h1}` },
      body: rawBody,
    }),
    env,
  );
}

describe("Paddle webhook lanes", () => {
  it("404s the sandbox destination when no sandbox lane or secret exists", async () => {
    for (const mode of ["production", undefined]) {
      const env = laneEnv(mode);
      delete env.PADDLE_SANDBOX_WEBHOOK_SECRET;
      const res = await postWebhook(
        "/v1/paddle/webhook/sandbox",
        env,
        subscriptionEvent(SANDBOX_PRICES.pro),
        SANDBOX_SECRET,
      );
      expect(res.status).toBe(404);
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("rejects a live-signed event on the sandbox destination", async () => {
    const res = await postWebhook(
      "/v1/paddle/webhook/sandbox",
      laneEnv("sandbox"),
      subscriptionEvent(SANDBOX_PRICES.pro),
      LIVE_SECRET,
    );
    expect(res.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("rejects a sandbox-signed event on the live destination", async () => {
    const res = await postWebhook(
      "/v1/paddle/webhook",
      laneEnv("sandbox"),
      subscriptionEvent(LIVE_PRICES.pro),
      SANDBOX_SECRET,
    );
    expect(res.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("rejects everything on the sandbox destination when no sandbox secret is set", async () => {
    const env = laneEnv("sandbox");
    delete env.PADDLE_SANDBOX_WEBHOOK_SECRET;
    for (const secret of [LIVE_SECRET, SANDBOX_SECRET]) {
      const res = await postWebhook(
        "/v1/paddle/webhook/sandbox",
        env,
        subscriptionEvent(SANDBOX_PRICES.pro),
        secret,
      );
      expect(res.status).toBe(401);
    }
  });

  it("drops a correctly signed sandbox event that maps to a production account", async () => {
    mocks.getUser.mockResolvedValue(
      userWithEmail(CUSTOMER_EMAIL, { subscription: { paddleCustomerId: "ctm_lane" } }),
    );
    const res = await postWebhook(
      "/v1/paddle/webhook/sandbox",
      laneEnv("sandbox"),
      subscriptionEvent(SANDBOX_PRICES.pro),
      SANDBOX_SECRET,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mapped: false });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("applies a correctly signed sandbox event to a QA account", async () => {
    mocks.getUser.mockResolvedValue(
      userWithEmail(QA_EMAIL, { subscription: { paddleCustomerId: "ctm_lane" } }),
    );
    const res = await postWebhook(
      "/v1/paddle/webhook/sandbox",
      laneEnv("sandbox"),
      subscriptionEvent(SANDBOX_PRICES.pro),
      SANDBOX_SECRET,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ mapped: false });
    expect(mocks.updateUserMetadata).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Worker -> Durable Object lane header
// ---------------------------------------------------------------------------

describe("quota-client lane header", () => {
  function capturingNamespace() {
    const headers: Headers[] = [];
    const ns = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (_url: string, init: RequestInit) => {
          headers.push(new Headers(init.headers));
          return Promise.resolve(
            Response.json({
              window: { windowStart: 0, drafts: 0, tokens: 0, reservedTokens: 0 },
            }),
          );
        },
      }),
    } as unknown as DurableObjectNamespace;
    return { ns, headers };
  }

  it("forwards the sandbox lane to the Durable Object", async () => {
    const { ns, headers } = capturingNamespace();
    const env = { ...paddleEnvForLane(laneEnv("sandbox"), "sandbox"), ACCOUNT_QUOTA: ns };
    await quotaPeek(env, "user_lane", { now: Date.now() });
    expect(headers[0].get(PADDLE_LANE_HEADER)).toBe("sandbox");
  });

  it("sends no lane header for production", async () => {
    const { ns, headers } = capturingNamespace();
    const env = { ...paddleEnvForLane(laneEnv("sandbox"), "production"), ACCOUNT_QUOTA: ns };
    await quotaPeek(env, "user_lane", { now: Date.now() });
    expect(headers[0].has(PADDLE_LANE_HEADER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex review fixes: stored lanes, incomplete config
// ---------------------------------------------------------------------------

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

function authOf(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("Authorization");
}

async function seedReservation(
  userId: string,
  reservation: Record<string, unknown>,
): Promise<void> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY, reservation);
  });
}

async function storedReservation(userId: string): Promise<Record<string, unknown> | undefined> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.get<Record<string, unknown>>(
      PADDLE_SUBSCRIPTION_CHECKOUT_RESERVATION_STORAGE_KEY,
    ),
  );
}

function openTransaction(id: string, priceId: string): Response {
  return new Response(
    JSON.stringify({
      data: {
        id,
        status: "ready",
        checkout: { url: `https://checkout.paddle.com/pay?_ptxn=${id}` },
        items: [{ price: { id: priceId }, quantity: 1 }],
      },
    }),
    { status: 200 },
  );
}

async function deleteMe(env: Env): Promise<Response> {
  return worker.fetch(
    new Request("https://sentwise-inference.test/v1/me", { method: "DELETE", headers: bearer() }),
    env,
  );
}

describe("pending checkout reservations remember their lane (P1)", () => {
  it("stamps a sandbox checkout's reservation and leaves a live one unstamped", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(transactionCreated())),
    );
    expect((await postCheckout(laneEnv("sandbox"), SANDBOX_PRICES.pro)).status).toBe(200);
    expect(await storedReservation("user_lane")).toMatchObject({ paddleEnvironment: "sandbox" });

    await clearReservations("user_lane");
    __resetClerkUserCache();
    mocks.getUser.mockResolvedValue(userWithEmail(CUSTOMER_EMAIL, { subscription: null }));
    expect((await postCheckout(laneEnv("sandbox"), LIVE_PRICES.pro)).status).toBe(200);
    expect(await storedReservation("user_lane")).not.toHaveProperty("paddleEnvironment");
  });

  it("checks a pending LIVE checkout on the live API after the sandbox lane opens", async () => {
    // QA account started a live checkout (e.g. fallback method 1); then
    // PADDLE_ENV flipped to sandbox. The live transaction is still payable.
    await seedReservation("user_lane", {
      reservationId: "res_live",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      transactionId: "txn_live",
      priceId: LIVE_PRICES.pro,
      quantity: 1,
    });
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith(PADDLE_LIVE_API_BASE) && authOf(init) === `Bearer ${LIVE_KEY}`) {
        return Promise.resolve(openTransaction("txn_live", LIVE_PRICES.pro));
      }
      // The sandbox has never heard of a live transaction.
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await deleteMe(laneEnv("sandbox"));

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_checkout_pending");
    expect(await storedReservation("user_lane")).toMatchObject({ transactionId: "txn_live" });
    for (const [input] of fetchMock.mock.calls) {
      expect(urlOf(input)).not.toContain("sandbox-api.paddle.com");
    }
  });

  it("checks a pending SANDBOX checkout on the sandbox API after the lane closes", async () => {
    await seedReservation("user_lane", {
      reservationId: "res_sbx",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      transactionId: "txn_sbx",
      priceId: SANDBOX_PRICES.pro,
      quantity: 1,
      paddleEnvironment: "sandbox",
    });
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith(PADDLE_SANDBOX_API_BASE) && authOf(init) === `Bearer ${SANDBOX_KEY}`) {
        return Promise.resolve(openTransaction("txn_sbx", SANDBOX_PRICES.pro));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await deleteMe(laneEnv("production"));

    expect(res.status).toBe(409);
    expect(await storedReservation("user_lane")).toMatchObject({ transactionId: "txn_sbx" });
  });

  it("cancels a pending checkout from the other lane where it lives before minting", async () => {
    await seedReservation("user_lane", {
      reservationId: "res_live",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      transactionId: "txn_live",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_live",
      priceId: LIVE_PRICES.pro,
      quantity: 1,
    });
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    let liveCanceled = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === `${PADDLE_LIVE_API_BASE}/transactions/txn_live` && init?.method === "PATCH") {
        expect(authOf(init)).toBe(`Bearer ${LIVE_KEY}`);
        liveCanceled = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      if (url === `${PADDLE_LIVE_API_BASE}/transactions/txn_live`) {
        if (liveCanceled) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: { id: "txn_live", status: "canceled" } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(openTransaction("txn_live", LIVE_PRICES.pro));
      }
      if (url === `${PADDLE_SANDBOX_API_BASE}/transactions` && init?.method === "POST") {
        return Promise.resolve(transactionCreated());
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("sandbox"), SANDBOX_PRICES.pro);

    expect(res.status).toBe(200);
    expect(liveCanceled).toBe(true);
    expect(await storedReservation("user_lane")).toMatchObject({
      transactionId: "txn_lane",
      paddleEnvironment: "sandbox",
    });
  });
});

const SANDBOX_SUBSCRIPTION = {
  plan: "pro",
  status: "active",
  renewsAt: "2026-11-12T00:00:00.000Z",
  manageBillingUrl: null,
  paddleSubscriptionId: "sub_sbx",
  paddleCustomerId: "ctm_sbx",
  priceId: SANDBOX_PRICES.pro,
  paddleEnvironment: "sandbox",
};

const LIVE_SUBSCRIPTION = {
  plan: "pro",
  status: "active",
  renewsAt: "2026-11-12T00:00:00.000Z",
  manageBillingUrl: null,
  paddleSubscriptionId: "sub_live",
  paddleCustomerId: "ctm_live",
  priceId: LIVE_PRICES.pro,
};

async function getMe(env: Env): Promise<any> {
  const res = await worker.fetch(
    new Request("https://sentwise-inference.test/v1/me", { headers: bearer() }),
    env,
  );
  expect(res.status).toBe(200);
  return res.json();
}

describe("subscriptions remember their environment (P2)", () => {
  it("a sandbox subscription is paid only while the account is in the sandbox lane", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    const meta = { subscription: SANDBOX_SUBSCRIPTION, quota: { monthlyDraftLimit: 120 } };

    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, meta));
    const open = await getMe(laneEnv("sandbox"));
    expect(open.subscription).toMatchObject({ plan: "pro", status: "active" });
    expect(open.quota.limit).toBe(120);

    // Lane closed: stranded test data, not a paid plan, no tier cap.
    __resetClerkUserCache();
    const closed = await getMe(laneEnv("production"));
    expect(closed.subscription.plan).not.toBe("pro");
    expect(closed.quota.limit).not.toBe(120);

    // Email moved off the QA domain while the lane is open: also stranded.
    __resetClerkUserCache();
    mocks.getUser.mockResolvedValue(userWithEmail(CUSTOMER_EMAIL, meta));
    const moved = await getMe(laneEnv("sandbox"));
    expect(moved.subscription.plan).not.toBe("pro");
  });

  it("a live subscription stays paid whichever lane the account is in", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: LIVE_SUBSCRIPTION }));
    for (const mode of ["sandbox", "production"]) {
      __resetClerkUserCache();
      expect((await getMe(laneEnv(mode))).subscription).toMatchObject({ plan: "pro" });
    }
  });

  it("manage billing for a stranded sandbox subscription goes to the sandbox API", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(
      userWithEmail(QA_EMAIL, { subscription: SANDBOX_SUBSCRIPTION }),
    );
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 500 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      new Request("https://sentwise-inference.test/v1/paddle/manage-billing", {
        headers: bearer(),
      }),
      laneEnv("production"),
    );

    expect(fetchMock).toHaveBeenCalled();
    for (const [input, init] of fetchMock.mock.calls) {
      expect(urlOf(input).startsWith(PADDLE_SANDBOX_API_BASE)).toBe(true);
      expect(authOf(init)).toBe(`Bearer ${SANDBOX_KEY}`);
    }
  });

  it("manage billing for a live subscription goes live even inside the sandbox lane", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: LIVE_SUBSCRIPTION }));
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 500 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      new Request("https://sentwise-inference.test/v1/paddle/manage-billing", {
        headers: bearer(),
      }),
      laneEnv("sandbox"),
    );

    expect(fetchMock).toHaveBeenCalled();
    for (const [input, init] of fetchMock.mock.calls) {
      expect(urlOf(input).startsWith(PADDLE_LIVE_API_BASE)).toBe(true);
      expect(authOf(init)).toBe(`Bearer ${LIVE_KEY}`);
    }
  });

  it("a live checkout ignores a stranded sandbox subscription and its customer id", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(
      userWithEmail(QA_EMAIL, { subscription: SANDBOX_SUBSCRIPTION }),
    );
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(transactionCreated()),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("production"), LIVE_PRICES.pro);

    expect(res.status).toBe(200);
    expect(urlOf(fetchMock.mock.calls[0][0])).toBe(`${PADDLE_LIVE_API_BASE}/transactions`);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, any>;
    expect(body.customer_id).toBeUndefined();
  });

  it("an active live subscription still blocks a sandbox checkout", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: LIVE_SUBSCRIPTION }));
    const fetchMock = vi.fn(() => Promise.resolve(transactionCreated()));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postCheckout(laneEnv("sandbox"), SANDBOX_PRICES.pro);

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a plan change on a subscription from the other lane", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(
      userWithEmail(QA_EMAIL, { subscription: SANDBOX_SUBSCRIPTION }),
    );
    const fetchMock = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://sentwise-inference.test/v1/paddle/change-plan", {
        method: "POST",
        headers: bearer(),
        body: JSON.stringify({ priceId: LIVE_PRICES.unlimited }),
      }),
      laneEnv("production"),
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.type).toBe("billing_environment_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stamps a subscription written from a sandbox event", async () => {
    mocks.getUser.mockResolvedValue(
      userWithEmail(QA_EMAIL, { subscription: { paddleCustomerId: "ctm_lane" } }),
    );
    const res = await postWebhook(
      "/v1/paddle/webhook/sandbox",
      laneEnv("sandbox"),
      subscriptionEvent(SANDBOX_PRICES.pro),
      SANDBOX_SECRET,
    );
    expect(res.status).toBe(200);
    const written = mocks.updateUserMetadata.mock.calls.at(-1)?.[1]?.privateMetadata;
    expect(written?.subscription).toMatchObject({ paddleEnvironment: "sandbox" });
  });

  it("still delivers a sandbox cancellation after the lane closes and the email changes", async () => {
    mocks.getUser.mockResolvedValue(
      userWithEmail(CUSTOMER_EMAIL, {
        subscription: {
          ...SANDBOX_SUBSCRIPTION,
          paddleSubscriptionId: "sub_lane",
          paddleCustomerId: "ctm_lane",
        },
      }),
    );
    const canceled = JSON.parse(subscriptionEvent(SANDBOX_PRICES.pro));
    canceled.event_type = "subscription.canceled";
    canceled.data.status = "canceled";
    const res = await postWebhook(
      "/v1/paddle/webhook/sandbox",
      laneEnv("production"),
      JSON.stringify(canceled),
      SANDBOX_SECRET,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ mapped: false });
    const written = mocks.updateUserMetadata.mock.calls.at(-1)?.[1]?.privateMetadata;
    expect(written?.subscription).toMatchObject({
      status: "canceled",
      paddleEnvironment: "sandbox",
    });
  });

  it("never lets a sandbox event overwrite a live subscription in force", async () => {
    mocks.getUser.mockResolvedValue(
      userWithEmail(QA_EMAIL, {
        subscription: { ...LIVE_SUBSCRIPTION, paddleCustomerId: "ctm_lane" },
      }),
    );
    const res = await postWebhook(
      "/v1/paddle/webhook/sandbox",
      laneEnv("sandbox"),
      subscriptionEvent(SANDBOX_PRICES.pro),
      SANDBOX_SECRET,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("incomplete sandbox lane fails closed (P3)", () => {
  function incompleteEnv(): Env {
    const env = laneEnv("sandbox");
    delete env.PADDLE_SANDBOX_CLIENT_TOKEN;
    return env;
  }

  it("/v1/me tells a QA account checkout is unavailable instead of production", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL));
    expect((await getMe(incompleteEnv())).billing).toEqual({
      environment: "sandbox",
      checkoutAvailable: false,
    });
  });

  it("checkout refuses the QA account with 503 and never calls Paddle", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(QA_EMAIL, { subscription: null }));
    const fetchMock = vi.fn(() => Promise.resolve(transactionCreated()));
    vi.stubGlobal("fetch", fetchMock);

    for (const price of [LIVE_PRICES.pro, SANDBOX_PRICES.pro]) {
      const res = await postCheckout(incompleteEnv(), price);
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error.type).toBe("sandbox_checkout_unavailable");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("production accounts are unaffected by an incomplete sandbox lane", async () => {
    mocks.verifyToken.mockResolvedValue({ sub: "user_lane" });
    mocks.getUser.mockResolvedValue(userWithEmail(CUSTOMER_EMAIL, { subscription: null }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(transactionCreated())),
    );
    expect((await getMe(incompleteEnv())).billing).toEqual({
      environment: "production",
      checkoutAvailable: true,
    });
    expect((await postCheckout(incompleteEnv(), LIVE_PRICES.pro)).status).toBe(200);
  });
});
