import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import { computeHmacSha256Hex } from "../src/paddle";
import { mondayStartUtc, WEEK_MS } from "../src/metering";

// Mock @clerk/backend — the webhook resolves + writes the user's privateMetadata.
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUserMetadata: vi.fn(),
  getUserList: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(),
  createClerkClient: () => ({
    users: {
      getUser: mocks.getUser,
      updateUserMetadata: mocks.updateUserMetadata,
      getUserList: mocks.getUserList,
    },
  }),
}));

import worker from "../src/index";
import { buildPaddleCheckoutCustomData } from "../src/paddle-account";
import {
  PADDLE_OVERAGE_CREDITS_STORAGE_KEY,
  PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX,
  PADDLE_OVERAGE_PENDING_REVERSALS_STORAGE_KEY,
  PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX,
  recordPaddleOverageInClerk,
  type PaddleOverageLedgerStore,
} from "../src/paddle-entitlement";
import { PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY } from "../src/quota-do";

const STARTER_PRICE = "pri_01m1syd7nfarp8pggpcnvjbgyy";
const PRO_PRICE = "pri_01m1symsxarc4c3jdea0ntb09w";
const UNLIMITED_PRICE = "pri_01m1syrdg05f49kz705gbzn6tz";
const OVERAGE_PRICE = "pri_overage";
const SECRET = "pdl_ntfset_testsecret";

const env: Env = {
  ...testEnv,
  CLERK_SECRET_KEY: "sk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
  PADDLE_WEBHOOK_SECRET: SECRET,
  PADDLE_API_KEY: "pdl_apikey",
  PADDLE_API_BASE: "https://sandbox-api.paddle.com",
  STARTER_DRAFT_LIMIT: "30",
  PRO_DRAFT_LIMIT: "120",
  UNLIMITED_DRAFT_LIMIT: "100000",
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/customers/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { email: "marcus@example.com" } }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }),
  );
  mocks.getUser.mockReset();
  mocks.updateUserMetadata.mockReset();
  mocks.getUserList.mockReset();
  mocks.updateUserMetadata.mockResolvedValue(undefined);
  await clearPaddleOverageCredits();
});

function userWith(privateMetadata: Record<string, unknown>) {
  const metadata = withDefaultPaddleCustomer(privateMetadata);
  return {
    id: "user_abc",
    primaryEmailAddressId: "ema_1",
    emailAddresses: [{ id: "ema_1", emailAddress: "marcus@example.com" }],
    privateMetadata: metadata,
  };
}

function withDefaultPaddleCustomer(
  privateMetadata: Record<string, unknown>,
): Record<string, unknown> {
  if (privateMetadata.subscription === undefined) {
    return { ...privateMetadata, subscription: { paddleCustomerId: "ctm_123" } };
  }
  if (typeof privateMetadata.subscription === "object" && privateMetadata.subscription !== null) {
    const subscription = privateMetadata.subscription as Record<string, unknown>;
    if (subscription.paddleCustomerId === undefined) {
      return {
        ...privateMetadata,
        subscription: { ...subscription, paddleCustomerId: "ctm_123" },
      };
    }
  }
  return privateMetadata;
}

async function signedReq(
  rawBody: string,
  opts?: { ts?: number; overrideEnv?: Env },
): Promise<Response> {
  const ts = opts?.ts ?? Math.floor(Date.now() / 1000);
  const h1 = await computeHmacSha256Hex(SECRET, `${ts}:${rawBody}`);
  return worker.fetch(
    new Request("https://sentwise-inference.test/v1/paddle/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "Paddle-Signature": `ts=${ts};h1=${h1}` },
      body: rawBody,
    }),
    opts?.overrideEnv ?? env,
  );
}

function subBody(fields: {
  eventType?: string;
  eventId?: string;
  occurredAt?: string;
  status?: string;
  priceId?: string;
  clerkUserId?: string | null;
  customerId?: string;
  subscriptionId?: string;
  nextBilledAt?: string;
  customData?: Record<string, unknown>;
}): string {
  const custom =
    fields.customData ??
    (fields.clerkUserId === null ? {} : { clerkUserId: fields.clerkUserId ?? "user_abc" });
  return JSON.stringify({
    event_id: fields.eventId ?? "evt_1",
    event_type: fields.eventType ?? "subscription.created",
    occurred_at: fields.occurredAt ?? "2026-09-05T10:00:00.000Z",
    data: {
      id: fields.subscriptionId ?? "sub_123",
      status: fields.status ?? "active",
      customer_id: fields.customerId ?? "ctm_123",
      next_billed_at: fields.nextBilledAt ?? "2026-10-05T10:00:00.000Z",
      custom_data: custom,
      items: [{ price: { id: fields.priceId ?? PRO_PRICE }, quantity: 1 }],
    },
  });
}

function lastWrite() {
  const call = mocks.updateUserMetadata.mock.calls.at(-1);
  return call?.[1]?.privateMetadata as { subscription?: any; quota?: any } | undefined;
}

async function clearPaddleOverageCredits(userId = "user_abc"): Promise<void> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.delete(PADDLE_OVERAGE_CREDITS_STORAGE_KEY);
    await state.storage.delete(PADDLE_OVERAGE_PENDING_REVERSALS_STORAGE_KEY);
    const sharded = await state.storage.list({
      prefix: PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX,
    });
    const pending = await state.storage.list({
      prefix: PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX,
    });
    await state.storage.delete(PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY);
    const keys = [...sharded.keys(), ...pending.keys()];
    if (keys.length > 0) await state.storage.delete(keys);
  });
}

async function storedPaddleOverageCredits(userId = "user_abc"): Promise<unknown[]> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  return runInDurableObject(stub, async (_instance, state) => {
    const legacy = await state.storage.get<unknown[]>(PADDLE_OVERAGE_CREDITS_STORAGE_KEY);
    const sharded = await state.storage.list<unknown>({
      prefix: PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX,
    });
    return [...(Array.isArray(legacy) ? legacy : []), ...sharded.values()];
  });
}

async function storedPaddleOverageCheckoutReservation(userId = "user_abc"): Promise<unknown> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  return runInDurableObject(stub, async (_instance, state) => {
    return state.storage.get(PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY);
  });
}

async function seedPaddleOverageCheckoutReservation(
  value: Record<string, unknown>,
  userId = "user_abc",
): Promise<void> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(PADDLE_OVERAGE_CHECKOUT_RESERVATION_STORAGE_KEY, value);
  });
}

async function storedPaddlePendingOverageReversals(userId = "user_abc"): Promise<unknown[]> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  return runInDurableObject(stub, async (_instance, state) => {
    const aggregate = await state.storage.get<unknown[]>(
      PADDLE_OVERAGE_PENDING_REVERSALS_STORAGE_KEY,
    );
    const sharded = await state.storage.list<unknown>({
      prefix: PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX,
    });
    return [...(Array.isArray(aggregate) ? aggregate : []), ...sharded.values()];
  });
}

async function putPaddleOverageCredits(credits: unknown[], userId = "user_abc"): Promise<void> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(PADDLE_OVERAGE_CREDITS_STORAGE_KEY, credits);
  });
}

async function storedPaddleOverageCreditKeys(userId = "user_abc"): Promise<string[]> {
  const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName(userId));
  return runInDurableObject(stub, async (_instance, state) => {
    const sharded = await state.storage.list({
      prefix: PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX,
    });
    const keys = [...sharded.keys()];
    if ((await state.storage.get(PADDLE_OVERAGE_CREDITS_STORAGE_KEY)) !== undefined) {
      keys.push(PADDLE_OVERAGE_CREDITS_STORAGE_KEY);
    }
    return keys.sort();
  });
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

describe("POST /v1/paddle/webhook — signature", () => {
  it("rejects a bad signature with 401 and never touches Clerk", async () => {
    const body = subBody({});
    const res = await worker.fetch(
      new Request("https://sentwise-inference.test/v1/paddle/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "Paddle-Signature": "ts=1;h1=deadbeef" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.type).toBe("invalid_signature");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 401", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({}), { ts: Math.floor(Date.now() / 1000) - 10 * 60 });
    expect(res.status).toBe(401);
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("405s a GET on the webhook path", async () => {
    const res = await worker.fetch(
      new Request("https://sentwise-inference.test/v1/paddle/webhook", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /v1/paddle/webhook — subscription lifecycle", () => {
  it("writes the subscription record + tier quota limit on subscription.created", async () => {
    mocks.getUser.mockResolvedValue(userWith({ trialStartedAt: "2026-08-01T00:00:00.000Z" }));
    const res = await signedReq(subBody({ priceId: PRO_PRICE }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true });

    const write = lastWrite();
    expect(write?.subscription).toMatchObject({
      plan: "pro",
      status: "active",
      renewsAt: "2026-10-05T10:00:00.000Z",
      paddleSubscriptionId: "sub_123",
      paddleCustomerId: "ctm_123",
      priceId: PRO_PRICE,
      lastEventId: "evt_1",
    });
    expect(write?.quota).toEqual({ weeklyDraftLimit: 120 });
  });

  it("maps each tier's price id to its configured draft limit", async () => {
    for (const [priceId, limit] of [
      [STARTER_PRICE, 30],
      [PRO_PRICE, 120],
      [UNLIMITED_PRICE, 100000],
    ] as const) {
      mocks.getUser.mockResolvedValue(userWith({}));
      const res = await signedReq(subBody({ priceId, eventId: `evt_${priceId}` }));
      expect(res.status).toBe(200);
      expect(lastWrite()?.quota).toEqual({ weeklyDraftLimit: limit });
    }
  });

  it("preserves other quota fields when setting the tier limit", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: { weeklyTokenLimit: 500000, extraDrafts: 7, extraDraftsWindowStart: 123 },
      }),
    );
    await signedReq(subBody({ priceId: STARTER_PRICE }));
    expect(lastWrite()?.quota).toEqual({
      weeklyTokenLimit: 500000,
      extraDrafts: 7,
      extraDraftsWindowStart: 123,
      weeklyDraftLimit: 30,
    });
  });

  it("records past_due status on subscription.past_due", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    await signedReq(subBody({ eventType: "subscription.past_due", status: "past_due" }));
    expect(lastWrite()?.subscription).toMatchObject({ status: "past_due", plan: "pro" });
  });

  it("records active status on subscription.activated", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({ eventType: "subscription.activated", status: "active" }));
    expect(res.status).toBe(200);
    expect(lastWrite()?.subscription).toMatchObject({ status: "active", plan: "pro" });
  });

  it("records paused subscriptions as canceled for access purposes", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({ eventType: "subscription.paused", status: "paused" }));
    expect(res.status).toBe(200);
    expect(lastWrite()?.subscription).toMatchObject({ status: "canceled", plan: "pro" });
    expect(lastWrite()?.quota.weeklyDraftLimit).toBeNull();
  });

  it("records resumed subscriptions as active", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({ eventType: "subscription.resumed", status: "active" }));
    expect(res.status).toBe(200);
    expect(lastWrite()?.subscription).toMatchObject({ status: "active", plan: "pro" });
  });

  it("records canceled status and removes the paid tier quota limit", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: { weeklyDraftLimit: 120, weeklyTokenLimit: 500000, extraDrafts: 7 },
      }),
    );
    await signedReq(subBody({ eventType: "subscription.canceled", status: "canceled" }));
    const write = lastWrite();
    expect(write?.subscription).toMatchObject({ status: "canceled", plan: "pro" });
    expect(write?.quota).toEqual({
      weeklyDraftLimit: null,
      weeklyTokenLimit: 500000,
      extraDrafts: 7,
    });
  });

  it("cancels a tracked overage checkout when the subscription is canceled", async () => {
    await seedPaddleOverageCheckoutReservation({
      reservationId: "overage-open",
      createdAt: Date.now(),
      transactionId: "txn_overage_open",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_overage_open",
      priceId: OVERAGE_PRICE,
      quantity: 2,
      customerId: "ctm_123",
    });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
        quota: { weeklyDraftLimit: 120 },
      }),
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://sandbox-api.paddle.com/transactions/txn_overage_open") {
        expect(init?.method).toBe("PATCH");
        expect(init?.body).toBe(JSON.stringify({ status: "canceled" }));
        return Promise.resolve(new Response(JSON.stringify({ data: { id: "txn_overage_open" } })));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await signedReq(
      subBody({ eventType: "subscription.canceled", status: "canceled" }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/transactions/txn_overage_open",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(await storedPaddleOverageCheckoutReservation()).toBeUndefined();
  });

  it("ignores an unknown price id (200, no write)", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({ priceId: "pri_unknown" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, ignored: "unknown_price" });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("applies a terminal event for the stored subscription even when its price is no longer mapped", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
          priceId: PRO_PRICE,
          lastEventId: "evt_old",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
        quota: { weeklyDraftLimit: 120, weeklyTokenLimit: 500000 },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.canceled",
        eventId: "evt_removed_price_cancel",
        status: "canceled",
        priceId: "pri_removed_from_catalog",
        occurredAt: "2026-09-06T00:00:00.000Z",
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(lastWrite()?.subscription).toMatchObject({
      plan: "pro",
      status: "canceled",
      paddleSubscriptionId: "sub_123",
      priceId: PRO_PRICE,
      lastEventId: "evt_removed_price_cancel",
    });
    expect(lastWrite()?.quota).toEqual({
      weeklyDraftLimit: null,
      weeklyTokenLimit: 500000,
    });
  });

  it("reuses the stored plan when a legacy subscription resumes with an unmapped price", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "canceled",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
          priceId: PRO_PRICE,
          lastEventId: "evt_cancel",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
        quota: { weeklyDraftLimit: null, weeklyTokenLimit: 500000 },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.resumed",
        eventId: "evt_removed_price_resume",
        status: "active",
        priceId: "pri_removed_from_catalog",
        occurredAt: "2026-09-06T00:00:00.000Z",
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(lastWrite()?.subscription).toMatchObject({
      plan: "pro",
      status: "active",
      paddleSubscriptionId: "sub_123",
      priceId: PRO_PRICE,
      lastEventId: "evt_removed_price_resume",
    });
    expect(lastWrite()?.quota).toEqual({
      weeklyDraftLimit: 120,
      weeklyTokenLimit: 500000,
    });
  });

  it("ignores an unhandled event type (200, no Clerk lookup)", async () => {
    const body = JSON.stringify({
      event_id: "e",
      event_type: "address.created",
      data: { id: "x" },
    });
    const res = await signedReq(body);
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, ignored: "unhandled_event_type" });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});

describe("POST /v1/paddle/webhook — idempotency & ordering", () => {
  it("skips an exact replay of an already-applied event", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          lastEventId: "evt_1",
          updatedAt: "2026-09-05T10:00:00.000Z",
        },
      }),
    );
    const res = await signedReq(subBody({ eventId: "evt_1" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("skips a strictly older (out-of-order) event", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          lastEventId: "evt_new",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
      }),
    );
    const res = await signedReq(
      subBody({ eventId: "evt_old", occurredAt: "2026-09-05T10:00:00.000Z" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("skips an older event whose Paddle timestamp differs below one millisecond", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
          lastEventId: "evt_new",
          updatedAt: "2026-09-05T10:00:00.123Z",
          paddleOccurredAt: "2026-09-05T10:00:00.123456Z",
        },
      }),
    );
    const res = await signedReq(
      subBody({
        eventId: "evt_old_subms",
        occurredAt: "2026-09-05T10:00:00.123123Z",
      }),
    );
    expect((await res.json()) as any).toEqual({ ok: true, stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("applies a newer event over an older stored record", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "active",
          lastEventId: "evt_old",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    const res = await signedReq(
      subBody({ eventId: "evt_new", priceId: PRO_PRICE, occurredAt: "2026-09-05T10:00:00.000Z" }),
    );
    expect(res.status).toBe(200);
    expect(lastWrite()?.subscription).toMatchObject({ plan: "pro", lastEventId: "evt_new" });
  });

  it("skips a newer canceled event from a superseded Paddle subscription", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_current",
          paddleCustomerId: "ctm_123",
          lastEventId: "evt_current",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.canceled",
        eventId: "evt_old_cancel",
        subscriptionId: "sub_old",
        status: "canceled",
        occurredAt: "2026-09-06T00:00:00.000Z",
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("skips an active retry from a superseded Paddle subscription", async () => {
    const customData = await buildPaddleCheckoutCustomData("user_abc", env);
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_current",
          paddleCustomerId: "ctm_123",
          supersededPaddleSubscriptionIds: ["sub_old"],
          lastEventId: "evt_current",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.activated",
        eventId: "evt_old_active_retry",
        subscriptionId: "sub_old",
        status: "active",
        occurredAt: "2026-09-06T00:00:00.000Z",
        customData,
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("checks Paddle before allowing a different active subscription to replace the stored one", async () => {
    const customData = await buildPaddleCheckoutCustomData("user_abc", env);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/subscriptions/sub_old")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: { customer_id: "ctm_123", status: "canceled" } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    );
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_current",
          paddleCustomerId: "ctm_123",
          lastEventId: "evt_current",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.activated",
        eventId: "evt_old_active_retry",
        subscriptionId: "sub_old",
        status: "active",
        occurredAt: "2026-09-06T00:00:00.000Z",
        customData,
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("allows a fresh active subscription to replace a different stored subscription", async () => {
    const customData = await buildPaddleCheckoutCustomData("user_abc", env);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/subscriptions/sub_current")) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: { customer_id: "ctm_123", status: "active" } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(new Response("{}", { status: 404 }));
      }),
    );
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "canceled",
          paddleSubscriptionId: "sub_old",
          paddleCustomerId: "ctm_123",
          lastEventId: "evt_old",
          updatedAt: "2026-09-06T00:00:00.000Z",
        },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.created",
        eventId: "evt_new_sub",
        subscriptionId: "sub_current",
        status: "active",
        occurredAt: "2026-09-05T00:00:00.000Z",
        customData,
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(lastWrite()?.subscription).toMatchObject({
      paddleSubscriptionId: "sub_current",
      status: "active",
      lastEventId: "evt_new_sub",
      supersededPaddleSubscriptionIds: ["sub_old"],
    });
  });

  it("skips a terminal event from another subscription while the stored one is active", async () => {
    const customData = await buildPaddleCheckoutCustomData("user_abc", env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "starter",
          status: "active",
          paddleSubscriptionId: "sub_old",
          paddleCustomerId: "ctm_123",
          lastEventId: "evt_old",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
      }),
    );

    const res = await signedReq(
      subBody({
        eventType: "subscription.canceled",
        eventId: "evt_new_sub_canceled",
        subscriptionId: "sub_current",
        status: "canceled",
        occurredAt: "2026-09-06T00:00:00.000Z",
        customData,
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, stale: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("serializes overlapping subscription writes before the ordering check", async () => {
    let storedMeta: Record<string, unknown> = {
      subscription: {
        plan: "starter",
        status: "active",
        lastEventId: "evt_initial",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      quota: { weeklyTokenLimit: 500000 },
    };
    const newWrite = deferred<void>();
    const newWriteStarted = deferred<void>();

    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation(async (_userId, update) => {
      const privateMetadata = update.privateMetadata as Record<string, unknown>;
      const subscription = privateMetadata.subscription as Record<string, unknown> | undefined;
      if (subscription?.lastEventId === "evt_new") {
        newWriteStarted.resolve();
        await newWrite.promise;
      }
      storedMeta = { ...storedMeta, ...privateMetadata };
    });

    const newer = signedReq(
      subBody({
        eventId: "evt_new",
        priceId: PRO_PRICE,
        occurredAt: "2026-09-06T00:00:00.000Z",
      }),
    );
    await newWriteStarted.promise;

    const older = signedReq(
      subBody({
        eventId: "evt_old",
        priceId: STARTER_PRICE,
        occurredAt: "2026-09-05T00:00:00.000Z",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateUserMetadata).toHaveBeenCalledTimes(1);

    newWrite.resolve();
    const [, olderRes] = await Promise.all([newer, older]);

    expect((await olderRes.json()) as any).toEqual({ ok: true, stale: true });
    expect(storedMeta.subscription).toMatchObject({ plan: "pro", lastEventId: "evt_new" });
    expect(storedMeta.quota).toMatchObject({ weeklyTokenLimit: 500000, weeklyDraftLimit: 120 });
  });
});

describe("POST /v1/paddle/webhook — overage (transaction.completed)", () => {
  function txnBody(
    data: Record<string, unknown>,
    eventId = "evt_txn",
    occurredAt = "2026-09-05T10:00:00.000Z",
  ): string {
    return JSON.stringify({
      event_id: eventId,
      event_type: "transaction.completed",
      occurred_at: occurredAt,
      data: {
        id: `txn_${eventId}`,
        customer_id: "ctm_123",
        custom_data: { clerkUserId: "user_abc" },
        ...data,
      },
    });
  }

  const overageEnv: Env = { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE };

  it("credits extra drafts stamped to the CURRENT Monday window", async () => {
    mocks.getUser.mockResolvedValue(userWith({ quota: { weeklyDraftLimit: 120 } }));
    const res = await signedReq(
      txnBody({
        custom_data: { clerkUserId: "user_abc", kind: "overage", extraDrafts: 1_000_000 },
        items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
      }),
      { overrideEnv: overageEnv },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true, extraDrafts: 25 });

    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(25);
    expect(quota.extraDraftsWindowStart).toBe(mondayStartUtc(Date.now()));
    expect(quota.weeklyDraftLimit).toBe(120); // preserved
    expect(quota.lastOverageEventId).toBe("evt_txn");
    expect(quota.processedOverageEventIds).toEqual(["evt_txn"]);
    expect(quota.overageCredits).toBeUndefined();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: mondayStartUtc(Date.now()),
      },
    ]);
    expect(await storedPaddleOverageCreditKeys()).toEqual([
      expect.stringMatching(new RegExp(`^${PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX}`)),
    ]);
  });

  it("does not credit a new overage purchase after the stored subscription is inactive", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "canceled",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
        quota: { weeklyDraftLimit: null },
      }),
    );

    const res = await signedReq(
      txnBody({
        custom_data: { clerkUserId: "user_abc", kind: "overage" },
        items: [{ price: { id: OVERAGE_PRICE }, quantity: 5 }],
      }),
      { overrideEnv: overageEnv },
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, mapped: false });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(await storedPaddleOverageCredits()).toEqual([]);
  });

  it("clears the tracked overage checkout after the matching transaction completes", async () => {
    await seedPaddleOverageCheckoutReservation({
      reservationId: "overage-open",
      createdAt: Date.now(),
      transactionId: "txn_evt_reserved",
      checkoutUrl: "https://checkout.paddle.com/pay?_ptxn=txn_evt_reserved",
      priceId: OVERAGE_PRICE,
      quantity: 2,
      customerId: "ctm_123",
    });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: {
          plan: "pro",
          status: "active",
          paddleSubscriptionId: "sub_123",
          paddleCustomerId: "ctm_123",
        },
        quota: { weeklyDraftLimit: 120 },
      }),
    );

    const res = await signedReq(
      txnBody(
        {
          custom_data: {
            clerkUserId: "user_abc",
            kind: "overage",
            sentwiseCheckoutReservationId: "overage-open",
          },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 2 }],
        },
        "evt_reserved",
      ),
      { overrideEnv: overageEnv },
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true, extraDrafts: 2 });
    expect(await storedPaddleOverageCheckoutReservation()).toBeUndefined();
  });

  it("accumulates a second purchase within the same window", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: { extraDrafts: 10, extraDraftsWindowStart: monday, lastOverageEventId: "evt_old" },
      }),
    );
    await signedReq(
      txnBody(
        {
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 5 }],
        },
        "evt_new",
      ),
      { overrideEnv: overageEnv },
    );
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(15);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.processedOverageEventIds).toEqual(["evt_old", "evt_new"]);
    expect(quota.overageCredits).toBeUndefined();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_new",
        transactionId: "txn_evt_new",
        extraDrafts: 5,
        windowStart: monday,
      },
    ]);
  });

  it("resets extras when the stored purchase belongs to a prior window", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({ quota: { extraDrafts: 99, extraDraftsWindowStart: 123 /* ancient */ } }),
    );
    await signedReq(
      txnBody({
        custom_data: { clerkUserId: "user_abc", kind: "overage" },
        items: [{ price: { id: OVERAGE_PRICE }, quantity: 5 }],
      }),
      { overrideEnv: overageEnv },
    );
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(5);
    expect(quota.extraDraftsWindowStart).toBe(mondayStartUtc(Date.now()));
  });

  it("is idempotent on the overage event id", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: {
          extraDrafts: 15,
          extraDraftsWindowStart: monday,
          lastOverageEventId: "evt_txn",
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              extraDrafts: 25,
              windowStart: monday,
              reversedDrafts: 10,
              reversalAdjustmentIds: ["adj_refund"],
              reversedDraftsByAdjustment: [
                { adjustmentId: "adj_refund", action: "refund", drafts: 10 },
              ],
            },
          ],
        },
      }),
    );
    const res = await signedReq(
      txnBody({
        custom_data: { clerkUserId: "user_abc", kind: "overage" },
        items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
      }),
      { overrideEnv: overageEnv },
    );
    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 10,
        reversalAdjustmentIds: ["adj_refund"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_refund", action: "refund", drafts: 10 }],
      },
    ]);
    expect(await storedPaddleOverageCreditKeys()).not.toContain(PADDLE_OVERAGE_CREDITS_STORAGE_KEY);
  });

  it("is idempotent when replaying any retained processed overage event id", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: {
          extraDrafts: 30,
          extraDraftsWindowStart: monday,
          lastOverageEventId: "evt_b",
          processedOverageEventIds: ["evt_a", "evt_b"],
        },
      }),
    );
    const res = await signedReq(
      txnBody(
        {
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 10 }],
        },
        "evt_a",
      ),
      { overrideEnv: overageEnv },
    );
    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(30);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.overageCreditTransactions).toEqual([
      {
        eventId: "evt_a",
        transactionId: "txn_evt_a",
        windowStart: monday,
        creditKeys: ["evt_a:txn_evt_a:"],
      },
    ]);
  });

  it("is idempotent when replaying an overage event retained only in the durable ledger", async () => {
    const monday = mondayStartUtc(Date.now());
    await putPaddleOverageCredits([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 10,
        reversalAdjustmentIds: ["adj_refund"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_refund", action: "refund", drafts: 10 }],
      },
    ]);
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: {
          extraDrafts: 15,
          extraDraftsWindowStart: monday,
          processedOverageEventIds: Array.from({ length: 100 }, (_, i) => `evt_old_${i}`),
        },
      }),
    );

    const res = await signedReq(
      txnBody({
        custom_data: { clerkUserId: "user_abc", kind: "overage" },
        items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
      }),
      { overrideEnv: overageEnv },
    );

    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 10,
        reversalAdjustmentIds: ["adj_refund"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_refund", action: "refund", drafts: 10 }],
      },
    ]);
  });

  it("repairs processed overage credits with the original event window", async () => {
    const currentMonday = mondayStartUtc(Date.now());
    const oldMonday = currentMonday - WEEK_MS;
    const oldOccurredAt = new Date(oldMonday + 12 * 60 * 60 * 1000).toISOString();
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: {
          extraDrafts: 5,
          extraDraftsWindowStart: currentMonday,
          processedOverageEventIds: ["evt_old"],
        },
      }),
    );

    const res = await signedReq(
      txnBody(
        {
          id: "txn_evt_old",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ id: "txnitm_old", price: { id: OVERAGE_PRICE }, quantity: 10 }],
        },
        "evt_old",
        oldOccurredAt,
      ),
      { overrideEnv: overageEnv },
    );

    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(5);
    expect(quota.extraDraftsWindowStart).toBe(currentMonday);
    expect(quota.overageCreditTransactions).toEqual([
      {
        eventId: "evt_old",
        transactionId: "txn_evt_old",
        windowStart: oldMonday,
        creditKeys: ["evt_old:txn_evt_old:txnitm_old"],
      },
    ]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_old",
        transactionId: "txn_evt_old",
        transactionItemId: "txnitm_old",
        extraDrafts: 10,
        windowStart: oldMonday,
      },
    ]);
  });

  it("serializes overlapping overage writes through the account Durable Object", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      quota: { extraDrafts: 0, extraDraftsWindowStart: monday },
    };
    const firstWrite = deferred<void>();
    const firstWriteStarted = deferred<void>();

    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation(async (_userId, update) => {
      const quota = update.privateMetadata.quota as Record<string, unknown>;
      if (quota.lastOverageEventId === "evt_a") {
        firstWriteStarted.resolve();
        await firstWrite.promise;
      }
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const first = signedReq(
      txnBody(
        {
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 10 }],
        },
        "evt_a",
      ),
      { overrideEnv: overageEnv },
    );
    await firstWriteStarted.promise;

    const second = signedReq(
      txnBody(
        {
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 5 }],
        },
        "evt_b",
      ),
      { overrideEnv: overageEnv },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateUserMetadata).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([first, second]);

    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(15);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.processedOverageEventIds).toEqual(["evt_a", "evt_b"]);
    expect(quota.overageCredits).toBeUndefined();
    expect(await storedPaddleOverageCredits()).toEqual([
      { eventId: "evt_a", transactionId: "txn_evt_a", extraDrafts: 10, windowStart: monday },
      { eventId: "evt_b", transactionId: "txn_evt_b", extraDrafts: 5, windowStart: monday },
    ]);
  });

  it("retains overage credit records beyond the newest 100 entries", async () => {
    const monday = mondayStartUtc(Date.now());
    const existingCredits = Array.from({ length: 100 }, (_, i) => ({
      eventId: `evt_old_${i}`,
      transactionId: `txn_old_${i}`,
      extraDrafts: 1,
      windowStart: monday,
    }));
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: {
          extraDrafts: 100,
          extraDraftsWindowStart: monday,
          overageCredits: existingCredits,
        },
      }),
    );

    await signedReq(
      txnBody(
        {
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 1 }],
        },
        "evt_new",
      ),
      { overrideEnv: overageEnv },
    );

    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(101);
    expect(quota.overageCredits).toBeNull();
    const credits = await storedPaddleOverageCredits();
    expect(credits).toHaveLength(101);
    expect(credits).toEqual(
      expect.arrayContaining([
        existingCredits[0],
        {
          eventId: "evt_new",
          transactionId: "txn_evt_new",
          extraDrafts: 1,
          windowStart: monday,
        },
      ]),
    );
    expect(await storedPaddleOverageCreditKeys()).toHaveLength(101);
  });

  it("writes only changed overage ledger shards", async () => {
    const monday = mondayStartUtc(Date.now());
    const existingCredits = [
      { eventId: "evt_a", transactionId: "txn_a", extraDrafts: 1, windowStart: monday },
      { eventId: "evt_b", transactionId: "txn_b", extraDrafts: 1, windowStart: monday },
    ];
    const values = new Map<string, unknown>(
      existingCredits.map((credit) => [testOverageCreditStorageKey(credit), credit]),
    );
    const putKeys: string[] = [];
    const ledgerStore: PaddleOverageLedgerStore = {
      get: <T = unknown>(key: string) => Promise.resolve(values.get(key) as T | undefined),
      put: (key, value) => {
        putKeys.push(key);
        values.set(key, value);
        return Promise.resolve();
      },
      list: <T = unknown>(options?: { prefix?: string }) =>
        Promise.resolve(
          new Map(
            [...values].filter(([key]) => !options?.prefix || key.startsWith(options.prefix)),
          ) as Map<string, T>,
        ),
      delete: (keyOrKeys) => {
        for (const key of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) {
          values.delete(key);
        }
        return Promise.resolve();
      },
    };
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 2,
          extraDraftsWindowStart: monday,
          processedOverageEventIds: ["evt_a", "evt_b"],
        },
      }),
    );

    await recordPaddleOverageInClerk(
      "user_abc",
      {
        now: Date.now(),
        eventId: "evt_c",
        transactionId: "txn_c",
        customerId: "ctm_123",
        extraDrafts: 1,
        credits: [{ transactionItemId: null, extraDrafts: 1, amount: null }],
      },
      env,
      ledgerStore,
    );

    expect(putKeys).toEqual([expect.stringContaining(encodeURIComponent("evt_c:txn_c:"))]);
  });

  it("serializes overlapping subscription and overage writes through the account Durable Object", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      quota: { extraDrafts: 0, extraDraftsWindowStart: monday },
    };
    const subscriptionWrite = deferred<void>();
    const subscriptionWriteStarted = deferred<void>();

    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation(async (_userId, update) => {
      const privateMetadata = update.privateMetadata as Record<string, unknown>;
      const subscription = privateMetadata.subscription as Record<string, unknown> | undefined;
      if (subscription?.lastEventId === "evt_sub") {
        subscriptionWriteStarted.resolve();
        await subscriptionWrite.promise;
      }
      storedMeta = { ...storedMeta, ...privateMetadata };
    });

    const subscription = signedReq(subBody({ eventId: "evt_sub", priceId: PRO_PRICE }));
    await subscriptionWriteStarted.promise;

    const overage = signedReq(
      txnBody(
        {
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 5 }],
        },
        "evt_overage",
      ),
      { overrideEnv: overageEnv },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateUserMetadata).toHaveBeenCalledTimes(1);

    subscriptionWrite.resolve();
    await Promise.all([subscription, overage]);

    expect(storedMeta.subscription).toMatchObject({ plan: "pro", lastEventId: "evt_sub" });
    expect(storedMeta.quota).toMatchObject({
      extraDrafts: 5,
      extraDraftsWindowStart: monday,
      lastOverageEventId: "evt_overage",
      weeklyDraftLimit: 120,
    });
    expect((storedMeta.quota as Record<string, unknown>).processedOverageEventIds).toEqual([
      "evt_overage",
    ]);
    expect((storedMeta.quota as Record<string, unknown>).overageCredits).toBeUndefined();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_overage",
        transactionId: "txn_evt_overage",
        extraDrafts: 5,
        windowStart: monday,
      },
    ]);
  });

  it("ignores a plain renewal transaction (no overage markers)", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(txnBody({ items: [{ price: { id: PRO_PRICE }, quantity: 1 }] }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, ignored: "not_overage" });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });
});

function testOverageCreditStorageKey(credit: {
  eventId: string;
  transactionId: string;
  transactionItemId?: string;
}): string {
  return `${PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX}${encodeURIComponent(
    `${credit.eventId}:${credit.transactionId}:${credit.transactionItemId ?? ""}`,
  )}`;
}

describe("POST /v1/paddle/webhook — overage reversals (adjustment.*)", () => {
  beforeEach(() => {
    mocks.getUserList.mockResolvedValue({ data: [{ id: "user_abc" }] });
  });

  function overageTxnBody(data: Record<string, unknown>, eventId = "evt_txn"): string {
    return JSON.stringify({
      event_id: eventId,
      event_type: "transaction.completed",
      occurred_at: "2026-09-05T10:00:00.000Z",
      data: {
        id: `txn_${eventId}`,
        customer_id: "ctm_123",
        custom_data: { clerkUserId: "user_abc" },
        ...data,
      },
    });
  }

  function adjustmentBody(data: Record<string, unknown> = {}, eventId = "evt_adj"): string {
    return JSON.stringify({
      event_id: eventId,
      event_type: data.event_type ?? "adjustment.updated",
      occurred_at: "2026-09-05T11:00:00.000Z",
      data: {
        id: "adj_123",
        action: "refund",
        status: "approved",
        transaction_id: "txn_evt_txn",
        customer_id: "ctm_123",
        ...data,
      },
    });
  }

  it("revokes current-window overage credit when an adjustment is approved", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 25,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              extraDrafts: 25,
              windowStart: monday,
            },
          ],
        },
      }),
    );

    const res = await signedReq(adjustmentBody());

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, revoked: true, extraDrafts: 25 });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(0);
    expect(quota.processedOverageAdjustmentIds).toEqual(["adj_123"]);
    expect(quota.overageCredits).toBeNull();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 25,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 25 }],
      },
    ]);
  });

  it("resolves adjustment owners from the original transaction checkout binding", async () => {
    const monday = mondayStartUtc(Date.now());
    const customData = await buildPaddleCheckoutCustomData("user_abc", env);
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/transactions/txn_evt_txn")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                id: "txn_evt_txn",
                customer_id: "ctm_123",
                custom_data: customData,
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("/customers/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { email: "billing-only@example.com" } }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUserList.mockResolvedValue({ data: [] });
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 25,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              extraDrafts: 25,
              windowStart: monday,
            },
          ],
        },
      }),
    );

    const res = await signedReq(adjustmentBody());

    expect((await res.json()) as any).toEqual({ ok: true, revoked: true, extraDrafts: 25 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/transactions/txn_evt_txn",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer pdl_apikey" }),
      }),
    );
    expect(mocks.getUserList).not.toHaveBeenCalled();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 25,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 25 }],
      },
    ]);
  });

  it("is idempotent on the adjustment id", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 0,
          extraDraftsWindowStart: monday,
          processedOverageAdjustmentIds: ["adj_123"],
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              extraDrafts: 25,
              windowStart: monday,
              reversedByAdjustmentId: "adj_123",
            },
          ],
        },
      }),
    );

    const res = await signedReq(adjustmentBody());

    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("is idempotent when replaying an adjustment retained on the credit ledger", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 40,
          extraDraftsWindowStart: monday,
          processedOverageAdjustmentIds: [],
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              transactionItemId: "txnitm_1",
              extraDrafts: 50,
              amount: 5000,
              windowStart: monday,
              reversedDrafts: 10,
              reversalAdjustmentIds: ["adj_123"],
              reversedDraftsByAdjustment: [
                { adjustmentId: "adj_123", action: "refund", drafts: 10 },
              ],
            },
          ],
        },
      }),
    );

    const res = await signedReq(
      adjustmentBody({
        type: "partial",
        items: [{ item_id: "txnitm_1", type: "partial", amount: "1000" }],
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 50,
        amount: 5000,
        windowStart: monday,
        reversedDrafts: 10,
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 10 }],
      },
    ]);
  });

  it("retains an approved reversal that arrives before the overage transaction", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {},
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const reversalRes = await signedReq(adjustmentBody());

    expect((await reversalRes.json()) as any).toEqual({ ok: true, pending: true });
    expect((storedMeta.quota as Record<string, unknown>).pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([
      {
        eventId: "evt_adj",
        adjustmentId: "adj_123",
        transactionId: "txn_evt_txn",
        action: "refund",
        adjustmentType: null,
        items: [],
      },
    ]);

    const transactionRes = await signedReq(
      overageTxnBody(
        {
          id: "txn_evt_txn",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
        },
        "evt_txn",
      ),
      { overrideEnv: { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE } },
    );

    expect((await transactionRes.json()) as any).toEqual({
      ok: true,
      applied: true,
      extraDrafts: 0,
    });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(0);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(quota.overageCredits).toBeUndefined();
    expect(await storedPaddlePendingOverageReversals()).toEqual([]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 25,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 25 }],
      },
    ]);
  });

  it("keeps pending reversals when purchase replay metadata writes fail", async () => {
    const monday = mondayStartUtc(Date.now());
    let failPurchaseWrite = true;
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {},
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      const quota = update.privateMetadata.quota as Record<string, unknown> | undefined;
      if (quota?.lastOverageEventId === "evt_txn" && failPurchaseWrite) {
        failPurchaseWrite = false;
        throw new Error("clerk write failed");
      }
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const reversalRes = await signedReq(adjustmentBody());

    expect((await reversalRes.json()) as any).toEqual({ ok: true, pending: true });
    expect(await storedPaddlePendingOverageReversals()).toHaveLength(1);

    const failedPurchaseRes = await signedReq(
      overageTxnBody(
        {
          id: "txn_evt_txn",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
        },
        "evt_txn",
      ),
      { overrideEnv: { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE } },
    );

    expect(failedPurchaseRes.status).toBe(502);
    expect(await storedPaddlePendingOverageReversals()).toHaveLength(1);
    expect(await storedPaddleOverageCredits()).toEqual([]);

    const retryRes = await signedReq(
      overageTxnBody(
        {
          id: "txn_evt_txn",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
        },
        "evt_txn",
      ),
      { overrideEnv: { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE } },
    );

    expect((await retryRes.json()) as any).toEqual({
      ok: true,
      applied: true,
      extraDrafts: 0,
    });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(0);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 25,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 25 }],
      },
    ]);
  });

  it("replays pending adjustments when repairing a processed overage purchase credit", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 25,
        extraDraftsWindowStart: monday,
        processedOverageEventIds: ["evt_txn"],
        processedOverageAdjustmentIds: ["adj_123"],
        pendingOverageReversals: [
          {
            eventId: "evt_adj",
            adjustmentId: "adj_123",
            transactionId: "txn_evt_txn",
            action: "refund",
            adjustmentType: null,
            items: [],
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const res = await signedReq(
      overageTxnBody(
        {
          id: "txn_evt_txn",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [{ price: { id: OVERAGE_PRICE }, quantity: 25 }],
        },
        "evt_txn",
      ),
      { overrideEnv: { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE } },
    );

    expect((await res.json()) as any).toEqual({ ok: true, idempotent: true });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(0);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(quota.overageCredits).toBeUndefined();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedDrafts: 25,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 25 }],
      },
    ]);
  });

  it("preserves full refunds across partial processed purchase ledger repairs", async () => {
    const monday = mondayStartUtc(Date.now());
    await putPaddleOverageCredits([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        windowStart: monday,
      },
    ]);
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 25,
        extraDraftsWindowStart: monday,
        processedOverageEventIds: ["evt_txn"],
        overageCreditTransactions: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            windowStart: monday,
            creditKeys: ["evt_txn:txn_evt_txn:txnitm_1", "evt_txn:txn_evt_txn:txnitm_2"],
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const refundRes = await signedReq(adjustmentBody({ type: "full" }));

    expect((await refundRes.json()) as any).toEqual({
      ok: true,
      revoked: true,
      extraDrafts: 10,
    });
    let quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(15);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([
      {
        eventId: "evt_adj",
        adjustmentId: "adj_123",
        transactionId: "txn_evt_txn",
        action: "refund",
        adjustmentType: "full",
        items: [],
      },
    ]);

    const retryRes = await signedReq(
      overageTxnBody(
        {
          id: "txn_evt_txn",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [
            { id: "txnitm_1", price: { id: OVERAGE_PRICE }, quantity: 10 },
            { id: "txnitm_2", price: { id: OVERAGE_PRICE }, quantity: 15 },
          ],
        },
        "evt_txn",
      ),
      { overrideEnv: { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE } },
    );

    expect((await retryRes.json()) as any).toEqual({ ok: true, idempotent: true });
    quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(0);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        windowStart: monday,
        reversedDrafts: 10,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 10 }],
      },
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_2",
        extraDrafts: 15,
        windowStart: monday,
        reversedDrafts: 15,
        reversedByAdjustmentId: "adj_123",
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 15 }],
      },
    ]);
  });

  it("preserves itemized adjustments across partial processed purchase ledger repairs", async () => {
    const monday = mondayStartUtc(Date.now());
    await putPaddleOverageCredits([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        windowStart: monday,
      },
    ]);
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 25,
        extraDraftsWindowStart: monday,
        processedOverageEventIds: ["evt_txn"],
        overageCreditTransactions: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            windowStart: monday,
            creditKeys: ["evt_txn:txn_evt_txn:txnitm_1", "evt_txn:txn_evt_txn:txnitm_2"],
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const adjustmentRes = await signedReq(
      adjustmentBody({
        id: "adj_itemized",
        type: "partial",
        items: [
          { item_id: "txnitm_1", type: "full" },
          { item_id: "txnitm_2", type: "full" },
        ],
      }),
    );

    expect((await adjustmentRes.json()) as any).toEqual({
      ok: true,
      revoked: true,
      extraDrafts: 10,
    });
    let quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(15);
    expect(await storedPaddlePendingOverageReversals()).toEqual([
      {
        eventId: "evt_adj",
        adjustmentId: "adj_itemized",
        transactionId: "txn_evt_txn",
        action: "refund",
        adjustmentType: "partial",
        hasAdjustmentItems: true,
        items: [
          { transactionItemId: "txnitm_1", type: "full", amount: null },
          { transactionItemId: "txnitm_2", type: "full", amount: null },
        ],
      },
    ]);

    const retryRes = await signedReq(
      overageTxnBody(
        {
          id: "txn_evt_txn",
          custom_data: { clerkUserId: "user_abc", kind: "overage" },
          items: [
            { id: "txnitm_1", price: { id: OVERAGE_PRICE }, quantity: 10 },
            { id: "txnitm_2", price: { id: OVERAGE_PRICE }, quantity: 15 },
          ],
        },
        "evt_txn",
      ),
      { overrideEnv: { ...env, EXTRA_DRAFTS_PRICE_ID: OVERAGE_PRICE } },
    );

    expect((await retryRes.json()) as any).toEqual({ ok: true, idempotent: true });
    quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(0);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        windowStart: monday,
        reversedDrafts: 10,
        reversedByAdjustmentId: "adj_itemized",
        reversalAdjustmentIds: ["adj_itemized"],
        reversedDraftsByAdjustment: [
          { adjustmentId: "adj_itemized", action: "refund", drafts: 10 },
        ],
      },
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_2",
        extraDrafts: 15,
        windowStart: monday,
        reversedDrafts: 15,
        reversedByAdjustmentId: "adj_itemized",
        reversalAdjustmentIds: ["adj_itemized"],
        reversedDraftsByAdjustment: [
          { adjustmentId: "adj_itemized", action: "refund", drafts: 15 },
        ],
      },
    ]);
  });

  it("retains more than 100 pending reversals awaiting purchase credits", async () => {
    const pending = Array.from({ length: 100 }, (_, i) => ({
      eventId: `evt_pending_${i}`,
      adjustmentId: `adj_pending_${i}`,
      transactionId: `txn_pending_${i}`,
      action: "refund",
      adjustmentType: null,
      items: [],
    }));
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: { pendingOverageReversals: pending },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const res = await signedReq(
      adjustmentBody({ id: "adj_new", transaction_id: "txn_new" }, "evt_adj_new"),
    );

    expect((await res.json()) as any).toEqual({ ok: true, pending: true });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.pendingOverageReversals).toEqual([]);
    const pendingReversals = await storedPaddlePendingOverageReversals();
    expect(pendingReversals).toHaveLength(101);
    expect(pendingReversals).toEqual(
      expect.arrayContaining([
        pending[0],
        {
          eventId: "evt_adj_new",
          adjustmentId: "adj_new",
          transactionId: "txn_new",
          action: "refund",
          adjustmentType: null,
          items: [],
        },
      ]),
    );
  });

  it("prorates a partial adjustment for one transaction item", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 50,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              transactionItemId: "txnitm_1",
              extraDrafts: 50,
              amount: 5000,
              windowStart: monday,
            },
          ],
        },
      }),
    );

    const res = await signedReq(
      adjustmentBody({
        type: "partial",
        items: [{ item_id: "txnitm_1", type: "partial", amount: "1000" }],
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, revoked: true, extraDrafts: 10 });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(40);
    expect(quota.overageCredits).toBeNull();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 50,
        amount: 5000,
        windowStart: monday,
        reversedDrafts: 10,
        reversalAdjustmentIds: ["adj_123"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", drafts: 10 }],
        adjustedAmountsByAdjustment: [{ adjustmentId: "adj_123", action: "refund", amount: 1000 }],
      },
    ]);
  });

  it("prorates cumulative partial adjustments before rounding", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 10,
        extraDraftsWindowStart: monday,
        overageCredits: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            transactionItemId: "txnitm_1",
            extraDrafts: 10,
            amount: 5000,
            windowStart: monday,
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    for (let i = 0; i < 5; i++) {
      const res = await signedReq(
        adjustmentBody(
          {
            id: `adj_small_${i}`,
            type: "partial",
            items: [{ item_id: "txnitm_1", type: "partial", amount: "100" }],
          },
          `evt_adj_small_${i}`,
        ),
      );

      expect((await res.json()) as any).toEqual({
        ok: true,
        revoked: true,
        extraDrafts: i === 0 ? 1 : 0,
      });
    }

    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(9);
    expect(quota.processedOverageAdjustmentIds).toEqual([
      "adj_small_0",
      "adj_small_1",
      "adj_small_2",
      "adj_small_3",
      "adj_small_4",
    ]);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        amount: 5000,
        windowStart: monday,
        reversedDrafts: 1,
        reversalAdjustmentIds: [
          "adj_small_0",
          "adj_small_1",
          "adj_small_2",
          "adj_small_3",
          "adj_small_4",
        ],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_small_0", action: "refund", drafts: 1 }],
        adjustedAmountsByAdjustment: [
          { adjustmentId: "adj_small_0", action: "refund", amount: 100 },
          { adjustmentId: "adj_small_1", action: "refund", amount: 100 },
          { adjustmentId: "adj_small_2", action: "refund", amount: 100 },
          { adjustmentId: "adj_small_3", action: "refund", amount: 100 },
          { adjustmentId: "adj_small_4", action: "refund", amount: 100 },
        ],
      },
    ]);
  });

  it("keeps partial adjustments pending when purchase amounts are unavailable", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 50,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              transactionItemId: "txnitm_1",
              extraDrafts: 50,
              windowStart: monday,
            },
          ],
        },
      }),
    );

    const res = await signedReq(
      adjustmentBody({
        type: "partial",
        items: [{ item_id: "txnitm_1", type: "partial", amount: "1000" }],
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, pending: true });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(50);
    expect(quota.processedOverageAdjustmentIds).toEqual(["adj_123"]);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([
      {
        eventId: "evt_adj",
        adjustmentId: "adj_123",
        transactionId: "txn_evt_txn",
        action: "refund",
        adjustmentType: "partial",
        hasAdjustmentItems: true,
        items: [{ transactionItemId: "txnitm_1", type: "partial", amount: 1000 }],
      },
    ]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 50,
        windowStart: monday,
      },
    ]);
  });

  it("ignores tax-only adjustment items without revoking overage credit", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 50,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              transactionItemId: "txnitm_1",
              extraDrafts: 50,
              amount: 5000,
              windowStart: monday,
            },
          ],
        },
      }),
    );

    const res = await signedReq(
      adjustmentBody({
        type: "partial",
        items: [{ item_id: "txnitm_tax", type: "tax", amount: "500" }],
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, ignored: "not_overage_reversal" });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("restores credits after an approved chargeback reversal", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 0,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              extraDrafts: 25,
              windowStart: monday,
              reversedDrafts: 25,
              reversedByAdjustmentId: "adj_chargeback",
              reversalAdjustmentIds: ["adj_chargeback"],
              reversedDraftsByAdjustment: [
                { adjustmentId: "adj_chargeback", action: "chargeback", drafts: 25 },
              ],
            },
          ],
        },
      }),
    );

    const res = await signedReq(
      adjustmentBody({ id: "adj_reverse", action: "chargeback_reverse", type: "full" }, "evt_rev"),
    );

    expect((await res.json()) as any).toEqual({ ok: true, restored: true, extraDrafts: 25 });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(25);
    expect(quota.processedOverageAdjustmentIds).toEqual(["adj_reverse"]);
    expect(quota.overageCredits).toBeNull();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversalAdjustmentIds: ["adj_chargeback"],
        restoredByAdjustmentIds: ["adj_reverse"],
      },
    ]);
  });

  it("removes restored partial adjustment amounts before later cumulative proration", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 5,
        extraDraftsWindowStart: monday,
        overageCredits: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            transactionItemId: "txnitm_1",
            extraDrafts: 10,
            amount: 10000,
            windowStart: monday,
            reversedDrafts: 5,
            reversalAdjustmentIds: ["adj_chargeback"],
            reversedDraftsByAdjustment: [
              { adjustmentId: "adj_chargeback", action: "chargeback", drafts: 5 },
            ],
            adjustedAmountsByAdjustment: [
              { adjustmentId: "adj_chargeback", action: "chargeback", amount: 5000 },
            ],
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const restored = await signedReq(
      adjustmentBody({ id: "adj_reverse", action: "chargeback_reverse", type: "full" }, "evt_rev"),
    );

    expect((await restored.json()) as any).toEqual({
      ok: true,
      restored: true,
      extraDrafts: 5,
    });
    expect((storedMeta.quota as Record<string, unknown>).extraDrafts).toBe(10);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        amount: 10000,
        windowStart: monday,
        reversalAdjustmentIds: ["adj_chargeback"],
        restoredByAdjustmentIds: ["adj_reverse"],
      },
    ]);

    const chargedBackAgain = await signedReq(
      adjustmentBody(
        {
          id: "adj_new",
          action: "chargeback",
          type: "partial",
          items: [{ item_id: "txnitm_1", type: "partial", amount: "1000" }],
        },
        "evt_new",
      ),
    );

    expect((await chargedBackAgain.json()) as any).toEqual({
      ok: true,
      revoked: true,
      extraDrafts: 1,
    });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(9);
    expect(quota.processedOverageAdjustmentIds).toEqual(["adj_reverse", "adj_new"]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        amount: 10000,
        windowStart: monday,
        reversedDrafts: 1,
        reversalAdjustmentIds: ["adj_chargeback", "adj_new"],
        restoredByAdjustmentIds: ["adj_reverse"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_new", action: "chargeback", drafts: 1 }],
        adjustedAmountsByAdjustment: [
          { adjustmentId: "adj_new", action: "chargeback", amount: 1000 },
        ],
      },
    ]);
  });

  it("prorates cumulative partial restoration adjustments before rounding", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 5,
        extraDraftsWindowStart: monday,
        overageCredits: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            transactionItemId: "txnitm_1",
            extraDrafts: 10,
            amount: 10000,
            windowStart: monday,
            reversedDrafts: 5,
            reversalAdjustmentIds: ["adj_chargeback"],
            reversedDraftsByAdjustment: [
              { adjustmentId: "adj_chargeback", action: "chargeback", drafts: 5 },
            ],
            adjustedAmountsByAdjustment: [
              { adjustmentId: "adj_chargeback", action: "chargeback", amount: 5000 },
            ],
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    for (let i = 0; i < 5; i++) {
      const res = await signedReq(
        adjustmentBody(
          {
            id: `adj_reverse_${i}`,
            action: "chargeback_reverse",
            type: "partial",
            items: [{ item_id: "txnitm_1", type: "partial", amount: "100" }],
          },
          `evt_reverse_${i}`,
        ),
      );

      expect((await res.json()) as any).toEqual({
        ok: true,
        restored: true,
        extraDrafts: i === 0 ? 1 : 0,
      });
    }

    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(6);
    expect(quota.processedOverageAdjustmentIds).toEqual([
      "adj_reverse_0",
      "adj_reverse_1",
      "adj_reverse_2",
      "adj_reverse_3",
      "adj_reverse_4",
    ]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        transactionItemId: "txnitm_1",
        extraDrafts: 10,
        amount: 10000,
        windowStart: monday,
        reversedDrafts: 4,
        reversalAdjustmentIds: ["adj_chargeback"],
        restoredByAdjustmentIds: [
          "adj_reverse_0",
          "adj_reverse_1",
          "adj_reverse_2",
          "adj_reverse_3",
          "adj_reverse_4",
        ],
        reversedDraftsByAdjustment: [
          { adjustmentId: "adj_chargeback", action: "chargeback", drafts: 4 },
        ],
        restoredDraftsByAdjustment: [
          { adjustmentId: "adj_reverse_0", action: "chargeback", drafts: 1 },
        ],
        adjustedAmountsByAdjustment: [
          { adjustmentId: "adj_chargeback", action: "chargeback", amount: 4500 },
        ],
        restoredAmountsByAdjustment: [
          { adjustmentId: "adj_reverse_0", action: "chargeback", amount: 100 },
          { adjustmentId: "adj_reverse_1", action: "chargeback", amount: 100 },
          { adjustmentId: "adj_reverse_2", action: "chargeback", amount: 100 },
          { adjustmentId: "adj_reverse_3", action: "chargeback", amount: 100 },
          { adjustmentId: "adj_reverse_4", action: "chargeback", amount: 100 },
        ],
      },
    ]);
  });

  it("restores only drafts revoked by the matching adjustment action", async () => {
    const monday = mondayStartUtc(Date.now());
    mocks.getUser.mockResolvedValue(
      userWith({
        subscription: { paddleCustomerId: "ctm_123" },
        quota: {
          extraDrafts: 20,
          extraDraftsWindowStart: monday,
          overageCredits: [
            {
              eventId: "evt_txn",
              transactionId: "txn_evt_txn",
              extraDrafts: 100,
              windowStart: monday,
              reversedDrafts: 80,
              reversalAdjustmentIds: ["adj_refund", "adj_chargeback"],
              reversedDraftsByAdjustment: [
                { adjustmentId: "adj_refund", action: "refund", drafts: 40 },
                { adjustmentId: "adj_chargeback", action: "chargeback", drafts: 40 },
              ],
            },
          ],
        },
      }),
    );

    const res = await signedReq(
      adjustmentBody({ id: "adj_reverse", action: "chargeback_reverse", type: "full" }, "evt_rev"),
    );

    expect((await res.json()) as any).toEqual({ ok: true, restored: true, extraDrafts: 40 });
    const quota = lastWrite()?.quota;
    expect(quota.extraDrafts).toBe(60);
    expect(quota.overageCredits).toBeNull();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 100,
        windowStart: monday,
        reversedDrafts: 40,
        reversalAdjustmentIds: ["adj_refund", "adj_chargeback"],
        restoredByAdjustmentIds: ["adj_reverse"],
        reversedDraftsByAdjustment: [{ adjustmentId: "adj_refund", action: "refund", drafts: 40 }],
      },
    ]);
  });

  it("ignores pending or rejected adjustments until Paddle approves them", async () => {
    mocks.getUser.mockResolvedValue(userWith({ subscription: { paddleCustomerId: "ctm_123" } }));

    for (const [status, action] of [
      ["pending_approval", "refund"],
      ["rejected", "refund"],
      ["approved", "chargeback_warning"],
    ]) {
      const res = await signedReq(adjustmentBody({ status, action }, `evt_adj_${status}`));
      expect((await res.json()) as any).toEqual({ ok: true, ignored: "adjustment_not_reversal" });
    }
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("retains a restore adjustment that arrives before its reversal", async () => {
    const monday = mondayStartUtc(Date.now());
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 25,
        extraDraftsWindowStart: monday,
        overageCredits: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            extraDrafts: 25,
            windowStart: monday,
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const restoreRes = await signedReq(
      adjustmentBody({ id: "adj_restore", action: "chargeback_reverse" }, "evt_restore"),
    );

    expect((await restoreRes.json()) as any).toEqual({ ok: true, pending: true });
    expect((storedMeta.quota as Record<string, unknown>).pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([
      {
        eventId: "evt_restore",
        adjustmentId: "adj_restore",
        transactionId: "txn_evt_txn",
        action: "chargeback_reverse",
        adjustmentType: null,
        items: [],
      },
    ]);

    const chargebackRes = await signedReq(
      adjustmentBody({ id: "adj_chargeback", action: "chargeback" }, "evt_chargeback"),
    );

    expect((await chargebackRes.json()) as any).toEqual({
      ok: true,
      revoked: true,
      extraDrafts: 25,
    });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(25);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([]);
    expect(quota.processedOverageAdjustmentIds).toEqual(["adj_restore", "adj_chargeback"]);
    expect(quota.overageCredits).toBeNull();
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversalAdjustmentIds: ["adj_chargeback"],
        restoredByAdjustmentIds: ["adj_restore"],
      },
    ]);
  });

  it("keeps replayed pending restores when reversal metadata writes fail", async () => {
    const monday = mondayStartUtc(Date.now());
    let failChargebackWrite = true;
    let storedMeta: Record<string, unknown> = {
      subscription: { paddleCustomerId: "ctm_123" },
      quota: {
        extraDrafts: 25,
        extraDraftsWindowStart: monday,
        overageCredits: [
          {
            eventId: "evt_txn",
            transactionId: "txn_evt_txn",
            extraDrafts: 25,
            windowStart: monday,
          },
        ],
      },
    };
    mocks.getUser.mockImplementation(() => Promise.resolve(userWith(storedMeta)));
    mocks.updateUserMetadata.mockImplementation((_userId, update) => {
      const quota = update.privateMetadata.quota as Record<string, unknown> | undefined;
      const processedAdjustmentIds = Array.isArray(quota?.processedOverageAdjustmentIds)
        ? quota.processedOverageAdjustmentIds
        : [];
      if (processedAdjustmentIds.includes("adj_chargeback") && failChargebackWrite) {
        failChargebackWrite = false;
        throw new Error("clerk write failed");
      }
      storedMeta = { ...storedMeta, ...update.privateMetadata };
    });

    const restoreRes = await signedReq(
      adjustmentBody({ id: "adj_restore", action: "chargeback_reverse" }, "evt_restore"),
    );

    expect((await restoreRes.json()) as any).toEqual({ ok: true, pending: true });
    expect(await storedPaddlePendingOverageReversals()).toHaveLength(1);

    const failedChargebackRes = await signedReq(
      adjustmentBody({ id: "adj_chargeback", action: "chargeback" }, "evt_chargeback"),
    );

    expect(failedChargebackRes.status).toBe(502);
    expect(await storedPaddlePendingOverageReversals()).toHaveLength(1);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
      },
    ]);

    const retryRes = await signedReq(
      adjustmentBody({ id: "adj_chargeback", action: "chargeback" }, "evt_chargeback"),
    );

    expect((await retryRes.json()) as any).toEqual({
      ok: true,
      revoked: true,
      extraDrafts: 25,
    });
    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(25);
    expect(quota.pendingOverageReversals).toEqual([]);
    expect(await storedPaddlePendingOverageReversals()).toEqual([]);
    expect(await storedPaddleOverageCredits()).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversalAdjustmentIds: ["adj_chargeback"],
        restoredByAdjustmentIds: ["adj_restore"],
      },
    ]);
  });
});

describe("POST /v1/paddle/webhook — user resolution", () => {
  it("acknowledges 200 mapped:false when no user can be resolved", async () => {
    const res = await signedReq(subBody({ clerkUserId: null, customerId: "ctm_x" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, mapped: false });
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("acknowledges 200 mapped:false for a stale custom_data.clerkUserId", async () => {
    mocks.getUser.mockRejectedValue({ status: 404 });
    const res = await signedReq(subBody({ clerkUserId: "user_deleted" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, mapped: false });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not trust custom_data.clerkUserId when the stored Paddle customer differs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(userWith({ subscription: { paddleCustomerId: "ctm_victim" } }));

    const res = await signedReq(subBody({ clerkUserId: "user_abc", customerId: "ctm_attacker" }));

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, mapped: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("does not trust unsigned first-time custom_data.clerkUserId even when the email matches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(userWith({ subscription: null }));

    const res = await signedReq(subBody({ clerkUserId: "user_abc", customerId: "ctm_attacker" }));

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, mapped: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("accepts signed checkout custom data for first-time Paddle customer binding", async () => {
    const customData = await buildPaddleCheckoutCustomData("user_abc", env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(userWith({ subscription: null, quota: {} }));

    const res = await signedReq(subBody({ customData, customerId: "ctm_new" }));

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastWrite()?.subscription.paddleCustomerId).toBe("ctm_new");
  });

  it("accepts signed checkout custom data from the previous binding secret", async () => {
    const customData = await buildPaddleCheckoutCustomData("user_abc", {
      ...env,
      PADDLE_CHECKOUT_BINDING_SECRET: "old_checkout_binding_secret",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(userWith({ subscription: null, quota: {} }));

    const res = await signedReq(subBody({ customData, customerId: "ctm_new" }), {
      overrideEnv: {
        ...env,
        PADDLE_CHECKOUT_BINDING_SECRET: "new_checkout_binding_secret",
        PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET: "old_checkout_binding_secret",
      },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastWrite()?.subscription.paddleCustomerId).toBe("ctm_new");
  });

  it("accepts custom_data.clerkUserId when the stored Paddle customer id matches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUser.mockResolvedValue(
      userWith({ subscription: { paddleCustomerId: "ctm_123" }, quota: {} }),
    );

    const res = await signedReq(subBody({ clerkUserId: "user_abc", customerId: "ctm_123" }));

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastWrite()?.subscription.paddleCustomerId).toBe("ctm_123");
  });

  it("returns 502 when direct Clerk user lookup fails transiently", async () => {
    mocks.getUser.mockRejectedValue(new Error("clerk down"));
    const res = await signedReq(subBody({ clerkUserId: "user_abc" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("account_lookup_failed");
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("falls back to matching the customer email in Clerk", async () => {
    const envWithApi: Env = {
      ...env,
      PADDLE_API_KEY: "pdl_apikey",
      PADDLE_API_BASE: "https://sandbox-api.paddle.com",
    };
    // Paddle customer lookup returns the email; Clerk finds the user by it.
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u.includes("/customers/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: { email: "marcus@example.com" } }), { status: 200 }),
        );
      }
      if (u.includes("/subscriptions/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                management_urls: { update_payment_method: "https://portal.paddle.com/manage/abc" },
              },
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.getUserList.mockResolvedValue({ data: [{ id: "user_matched" }] });
    mocks.getUser.mockResolvedValue({
      ...userWith({ subscription: { paddleCustomerId: "ctm_email" } }),
      id: "user_matched",
    });

    const res = await signedReq(subBody({ clerkUserId: null, customerId: "ctm_email" }), {
      overrideEnv: envWithApi,
    });
    expect(res.status).toBe(200);
    expect(mocks.getUserList).toHaveBeenCalledWith({ emailAddress: ["marcus@example.com"] });
    expect(mocks.getUser).toHaveBeenCalledWith("user_matched");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/subscriptions/"),
      expect.anything(),
    );
    expect(lastWrite()?.subscription.manageBillingUrl).toBeNull();
  });

  it("returns 502 when the Clerk email fallback lookup fails transiently", async () => {
    const envWithApi: Env = {
      ...env,
      PADDLE_API_KEY: "pdl_apikey",
      PADDLE_API_BASE: "https://sandbox-api.paddle.com",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { email: "marcus@example.com" } }), { status: 200 }),
        ),
      ),
    );
    mocks.getUserList.mockRejectedValue(new Error("clerk list down"));

    const res = await signedReq(subBody({ clerkUserId: null, customerId: "ctm_email" }), {
      overrideEnv: envWithApi,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("account_lookup_failed");
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("returns 502 when the Paddle API key is missing for email fallback", async () => {
    const res = await signedReq(subBody({ clerkUserId: null, customerId: "ctm_email" }), {
      overrideEnv: { ...env, PADDLE_API_KEY: "" },
    });

    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("customer_lookup_failed");
    expect(mocks.getUserList).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("returns 502 when the Paddle customer email lookup fails transiently", async () => {
    const envWithApi: Env = {
      ...env,
      PADDLE_API_KEY: "pdl_apikey",
      PADDLE_API_BASE: "https://sandbox-api.paddle.com",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 503 }))),
    );

    const res = await signedReq(subBody({ clerkUserId: null, customerId: "ctm_email" }), {
      overrideEnv: envWithApi,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error.type).toBe("customer_lookup_failed");
    expect(mocks.getUserList).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("returns 502 (Paddle retries) when the Clerk write fails", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    mocks.updateUserMetadata.mockRejectedValue(new Error("clerk down"));
    const res = await signedReq(subBody({ priceId: PRO_PRICE }));
    expect(res.status).toBe(502);
  });
});
