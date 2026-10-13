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
  paddleLaneForEmail,
  paddleLaneFromHeader,
  sandboxLaneEnabled,
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
      clientSideToken: SANDBOX_TOKEN,
      prices: SANDBOX_PRICES,
    });
  });

  it("never gives a production lane any sandbox value", () => {
    const config = paddleClientConfig(laneEnv("sandbox"), "production");
    expect(config).toEqual({ environment: "production" });
    expect(JSON.stringify(config)).not.toContain("test_");
  });

  it("reports production when the sandbox lane is off or incomplete", () => {
    expect(paddleClientConfig(laneEnv("production"), "sandbox")).toEqual({
      environment: "production",
    });
    const incomplete = laneEnv("sandbox");
    delete incomplete.PADDLE_SANDBOX_CLIENT_TOKEN;
    expect(paddleClientConfig(incomplete, "sandbox")).toEqual({ environment: "production" });
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
    expect(body.billing).toEqual({ environment: "production" });
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
    expect(((await res.json()) as any).billing).toEqual({ environment: "production" });
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
  it("404s the sandbox destination unless PADDLE_ENV=sandbox", async () => {
    for (const mode of ["production", undefined]) {
      const res = await postWebhook(
        "/v1/paddle/webhook/sandbox",
        laneEnv(mode),
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
