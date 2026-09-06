import { describe, it, expect, vi, beforeEach } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import { computeHmacSha256Hex } from "../src/paddle";
import { mondayStartUtc } from "../src/metering";

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

beforeEach(() => {
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
});

function userWith(privateMetadata: Record<string, unknown>) {
  return {
    id: "user_abc",
    primaryEmailAddressId: "ema_1",
    emailAddresses: [{ id: "ema_1", emailAddress: "marcus@example.com" }],
    privateMetadata,
  };
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
}): string {
  const custom =
    fields.clerkUserId === null ? {} : { clerkUserId: fields.clerkUserId ?? "user_abc" };
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
  });

  it("records resumed subscriptions as active", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({ eventType: "subscription.resumed", status: "active" }));
    expect(res.status).toBe(200);
    expect(lastWrite()?.subscription).toMatchObject({ status: "active", plan: "pro" });
  });

  it("records canceled status on subscription.canceled (keeping the tier for period access)", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    await signedReq(subBody({ eventType: "subscription.canceled", status: "canceled" }));
    const write = lastWrite();
    expect(write?.subscription).toMatchObject({ status: "canceled", plan: "pro" });
    expect(write?.quota).toEqual({ weeklyDraftLimit: 120 });
  });

  it("ignores an unknown price id (200, no write)", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(subBody({ priceId: "pri_unknown" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, ignored: "unknown_price" });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
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

  it("allows a fresh active subscription to replace a different stored subscription", async () => {
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
      }),
    );

    expect((await res.json()) as any).toEqual({ ok: true, applied: true });
    expect(lastWrite()?.subscription).toMatchObject({
      paddleSubscriptionId: "sub_current",
      status: "active",
      lastEventId: "evt_new_sub",
    });
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
  function txnBody(data: Record<string, unknown>, eventId = "evt_txn"): string {
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
    expect(quota.overageCredits).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: mondayStartUtc(Date.now()),
      },
    ]);
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
    expect(quota.overageCredits).toEqual([
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
    mocks.getUser.mockResolvedValue(
      userWith({
        quota: {
          extraDrafts: 25,
          extraDraftsWindowStart: mondayStartUtc(Date.now()),
          lastOverageEventId: "evt_txn",
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
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
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
    expect(quota.overageCredits).toEqual([
      { eventId: "evt_a", transactionId: "txn_evt_a", extraDrafts: 10, windowStart: monday },
      { eventId: "evt_b", transactionId: "txn_evt_b", extraDrafts: 5, windowStart: monday },
    ]);
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
    expect((storedMeta.quota as Record<string, unknown>).overageCredits).toEqual([
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

describe("POST /v1/paddle/webhook — overage reversals (adjustment.*)", () => {
  beforeEach(() => {
    mocks.getUserList.mockResolvedValue({ data: [{ id: "user_abc" }] });
  });

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
    expect(quota.overageCredits).toEqual([
      {
        eventId: "evt_txn",
        transactionId: "txn_evt_txn",
        extraDrafts: 25,
        windowStart: monday,
        reversedByAdjustmentId: "adj_123",
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

  it("ignores approved adjustments for transactions without stored overage credit", async () => {
    mocks.getUser.mockResolvedValue(
      userWith({ subscription: { paddleCustomerId: "ctm_123" }, quota: {} }),
    );

    const res = await signedReq(adjustmentBody());

    expect((await res.json()) as any).toEqual({ ok: true, ignored: "not_overage_reversal" });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
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

  it("does not trust custom_data.clerkUserId when the Paddle customer belongs to another email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { email: "attacker@example.com" } }), {
            status: 200,
          }),
        ),
      ),
    );
    mocks.getUser.mockResolvedValue(userWith({}));

    const res = await signedReq(subBody({ clerkUserId: "user_abc", customerId: "ctm_attacker" }));

    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, mapped: false });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
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
    mocks.getUser.mockResolvedValue({ ...userWith({}), id: "user_matched" });

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
