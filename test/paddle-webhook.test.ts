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
  // No PADDLE_API_KEY by default → manage-URL/email fetches are skipped (no global fetch).
  STARTER_DRAFT_LIMIT: "30",
  PRO_DRAFT_LIMIT: "120",
  UNLIMITED_DRAFT_LIMIT: "100000",
};

beforeEach(() => {
  vi.unstubAllGlobals();
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
  nextBilledAt?: string;
}): string {
  const custom =
    fields.clerkUserId === null ? {} : { clerkUserId: fields.clerkUserId ?? "user_abc" };
  return JSON.stringify({
    event_id: fields.eventId ?? "evt_1",
    event_type: fields.eventType ?? "subscription.created",
    occurred_at: fields.occurredAt ?? "2026-09-05T10:00:00.000Z",
    data: {
      id: "sub_123",
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
});

describe("POST /v1/paddle/webhook — overage (transaction.completed)", () => {
  function txnBody(data: Record<string, unknown>, eventId = "evt_txn"): string {
    return JSON.stringify({
      event_id: eventId,
      event_type: "transaction.completed",
      occurred_at: "2026-09-05T10:00:00.000Z",
      data: { customer_id: "ctm_123", custom_data: { clerkUserId: "user_abc" }, ...data },
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
    expect(mocks.getUser).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await Promise.all([first, second]);

    const quota = storedMeta.quota as Record<string, unknown>;
    expect(quota.extraDrafts).toBe(15);
    expect(quota.extraDraftsWindowStart).toBe(monday);
    expect(quota.processedOverageEventIds).toEqual(["evt_a", "evt_b"]);
  });

  it("ignores a plain renewal transaction (no overage markers)", async () => {
    mocks.getUser.mockResolvedValue(userWith({}));
    const res = await signedReq(txnBody({ items: [{ price: { id: PRO_PRICE }, quantity: 1 }] }));
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toEqual({ ok: true, ignored: "not_overage" });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });
});

describe("POST /v1/paddle/webhook — user resolution", () => {
  it("acknowledges 200 mapped:false when no user can be resolved", async () => {
    const res = await signedReq(subBody({ clerkUserId: null, customerId: "ctm_x" }));
    // No PADDLE_API_KEY → email fallback can't fetch → unmapped.
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
    // manage-billing URL fetched from the Paddle API and stored.
    expect(lastWrite()?.subscription.manageBillingUrl).toBe("https://portal.paddle.com/manage/abc");
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
