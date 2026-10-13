import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import type { PaddleEvent } from "../src/paddle";
import { buildPaddleCheckoutCustomData } from "../src/paddle-account";
import { recordPaddleSubscriptionInClerk } from "../src/paddle-subscription-entitlement";
import {
  PADDLE_OVERAGE_TOMBSTONES_STORAGE_KEY_PREFIX,
  recordPaddleOverageInClerk,
  retireOverageLedgerWithTombstones,
  type PaddleOverageLedgerStore,
} from "../src/paddle-entitlement";
import {
  PADDLE_LANE_HEADER,
  paddleEnvForStoredLane,
  storedPaddleLane,
  type PaddleLane,
} from "../src/paddle-env";
import { AccountQuota } from "../src/quota-do";
import {
  PADDLE_OVERAGE_CREDITS_STORAGE_KEY,
  PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX,
  PADDLE_OVERAGE_PENDING_REVERSALS_STORAGE_KEY,
  PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX,
  PADDLE_OVERAGE_LEDGER_LANE_STORAGE_KEY,
} from "../src/paddle-entitlement";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), updateUserMetadata: vi.fn() }));
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: mocks }),
}));

const env: Env = {
  ...testEnv,
  PADDLE_LANE: "production",
  PADDLE_API_BASE: "https://api.paddle.com",
  PADDLE_API_KEY: "test_live_key",
  PADDLE_WEBHOOK_SECRET: "test_live_secret",
  PADDLE_STARTER_PRICE_ID: "pri_live_starter",
  PADDLE_PRO_PRICE_ID: "pri_live_pro",
  PADDLE_UNLIMITED_PRICE_ID: "pri_live_unlimited",
  PRO_DRAFT_LIMIT: "120",
};
const now = Date.parse("2026-10-12T12:00:00Z");
let metadata: Record<string, any>;

// Model Clerk's deep merge, including null-key removal, rather than replacing
// nested subscription/quota objects (which would hide retained sandbox data).
function mergeMetadata(target: Record<string, any>, patch: Record<string, any>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (typeof value === "object" && !Array.isArray(value)) {
      mergeMetadata((target[key] ??= {}), value);
    } else target[key] = value;
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mocks.getUser.mockReset();
  mocks.updateUserMetadata.mockReset();
  metadata = {
    subscription: {
      plan: "pro",
      status: "active",
      paddleSubscriptionId: "sub_sandbox",
      paddleCustomerId: "ctm_sandbox",
      paddleEnvironment: "sandbox",
      priceId: "pri_sandbox_pro",
      paddleOccurredAt: "2026-10-11T12:00:00Z",
      supersededPaddleSubscriptionIds: ["sub_live_old"],
    },
    quota: {
      monthlyDraftLimit: 120,
      monthlyTokenLimit: 500000,
      enforcement: "hard",
      extraDrafts: 25,
      extraDraftsWindowStart: Date.parse("2026-10-01T00:00:00Z"),
      lastOverageEventId: "evt_sandbox_purchase",
      processedOverageEventIds: ["evt_sandbox_purchase"],
      processedOverageAdjustmentIds: ["adj_sandbox"],
      overageCreditTransactions: [{ transactionId: "txn_sandbox" }],
      overageCredits: [{ transactionId: "txn_sandbox", extraDrafts: 25 }],
      pendingOverageReversals: [{ adjustmentId: "adj_sandbox_pending" }],
    },
    unrelated: { keep: true },
  };
  mocks.getUser.mockImplementation(() =>
    Promise.resolve({ privateMetadata: structuredClone(metadata) }),
  );
  mocks.updateUserMetadata.mockImplementation((_userId, patch) => {
    mergeMetadata(metadata, patch.privateMetadata);
    return Promise.resolve();
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(Response.json({ data: { customer_id: "ctm_live", status: "active" } })),
    ),
  );
});

async function liveEvent(overrides: Partial<PaddleEvent> = {}): Promise<PaddleEvent> {
  return {
    eventId: "evt_live",
    eventType: "subscription.created",
    occurredAt: new Date(now).toISOString(),
    data: {
      id: "sub_live",
      customer_id: "ctm_live",
      status: "active",
      custom_data: await buildPaddleCheckoutCustomData("user_lane", env),
      items: [{ price: { id: "pri_live_pro" }, quantity: 1 }],
    },
    ...overrides,
  };
}

describe("subscription replacements across Paddle environments", () => {
  // Pass-3 review: timestamps are compared only within one Paddle environment.
  it("still rejects an older event for the same subscription in the same lane", async () => {
    delete metadata.subscription.paddleEnvironment;
    metadata.subscription.paddleSubscriptionId = "sub_live";
    metadata.subscription.paddleCustomerId = "ctm_live";
    const event = await liveEvent({ occurredAt: "2026-10-10T12:00:00Z" });
    event.eventType = "subscription.updated";

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, env)).toEqual({
      stale: true,
    });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("preserves overage credit and replay state for same-lane lifecycle events", async () => {
    delete metadata.subscription.paddleEnvironment;
    metadata.subscription.paddleSubscriptionId = "sub_live";
    metadata.subscription.paddleCustomerId = "ctm_live";
    const previousQuota = structuredClone(metadata.quota);

    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: await liveEvent() }, env),
    ).toEqual({ applied: true });
    expect(metadata.quota).toEqual(previousQuota);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the environment marker survives Clerk's deep merge correctly", () => {
  const sandboxEnv = paddleEnvForStoredLane(
    {
      ...env,
      PADDLE_LANE: undefined,
      PADDLE_ENV: "sandbox",
      PADDLE_SANDBOX_API_KEY: "test_sandbox_key",
      PADDLE_SANDBOX_WEBHOOK_SECRET: "test_sandbox_secret",
      PADDLE_SANDBOX_STARTER_PRICE_ID: "pri_sandbox_starter",
      PADDLE_SANDBOX_PRO_PRICE_ID: "pri_sandbox_pro",
      PADDLE_SANDBOX_UNLIMITED_PRICE_ID: "pri_sandbox_unlimited",
    },
    "sandbox",
  );

  async function sandboxEvent(overrides: Partial<PaddleEvent> = {}): Promise<PaddleEvent> {
    return {
      eventId: "evt_sandbox_new",
      eventType: "subscription.created",
      occurredAt: new Date(now).toISOString(),
      data: {
        id: "sub_sandbox_new",
        customer_id: "ctm_sandbox_new",
        status: "active",
        custom_data: await buildPaddleCheckoutCustomData("user_lane", sandboxEnv),
        items: [{ price: { id: "pri_sandbox_pro" }, quantity: 1 }],
      },
      ...overrides,
    };
  }

  async function withLedger(
    test: (storage: DurableObjectStorage, quota: AccountQuota) => Promise<void>,
  ): Promise<void> {
    const stub = testEnv.ACCOUNT_QUOTA.get(testEnv.ACCOUNT_QUOTA.idFromName("user_lane"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await test(state.storage, new AccountQuota(state, sandboxEnv.PADDLE_ROOT_ENV!));
    });
  }

  async function postQuota(
    quota: AccountQuota,
    path: string,
    body: unknown,
    lane: PaddleLane = "production",
  ) {
    const response = await quota.fetch(
      new Request(`https://account-quota.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [PADDLE_LANE_HEADER]: lane },
        body: JSON.stringify(body),
      }),
    );
    return response.json();
  }

  async function seedLedger(storage: DurableObjectStorage): Promise<string[]> {
    const credit = {
      eventId: "evt_sandbox_purchase",
      transactionId: "txn_sandbox",
      extraDrafts: 25,
      windowStart: Date.parse("2026-10-01T00:00:00Z"),
    };
    const pending = {
      eventId: "evt_pending",
      adjustmentId: "adj_pending",
      transactionId: "txn_pending",
      action: "refund",
      adjustmentType: "full",
      items: [],
    };
    const values = {
      [PADDLE_OVERAGE_CREDITS_STORAGE_KEY]: [credit],
      [PADDLE_OVERAGE_PENDING_REVERSALS_STORAGE_KEY]: [pending],
      // More than one storage delete batch, including both sharded families.
      ...Object.fromEntries(
        Array.from({ length: 130 }, (_, i) => [
          `${PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX}${i}`,
          credit,
        ]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 130 }, (_, i) => [
          `${PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX}${i}`,
          pending,
        ]),
      ),
    };
    for (const [key, value] of Object.entries(values)) await storage.put(key, value);
    await storage.put("unrelated", { keep: true });
    return Object.keys(values);
  }

  it.each(["same-lane"])(
    "preserves the durable ledgers on %s subscription writes",
    async (scenario) => {
      await withLedger(async (storage, quota) => {
        const keys = await seedLedger(storage);
        let event = await liveEvent();
        if (scenario === "same-lane") {
          delete metadata.subscription.paddleEnvironment;
          metadata.subscription.paddleSubscriptionId = "sub_live";
          metadata.subscription.paddleCustomerId = "ctm_live";
        } else if (scenario === "stale") {
          // Pass-3: an older live event is only stale when Paddle says the
          // live subscription is not active (timestamps aren't compared
          // across lanes).
          event = await liveEvent({ occurredAt: "2026-10-10T12:00:00Z" });
          event.eventType = "subscription.canceled";
          event.data.status = "canceled";
          vi.mocked(fetch).mockResolvedValue(
            Response.json({ data: { customer_id: "ctm_live", status: "canceled" } }),
          );
        } else {
          mocks.updateUserMetadata.mockRejectedValueOnce(new Error("Clerk unavailable"));
        }
        const result = await postQuota(quota, "/paddle-subscription", { now, event });
        if (scenario === "same-lane") expect(result).toEqual({ applied: true });
        else if (scenario === "stale") expect(result).toEqual({ stale: true });
        else expect(result).toMatchObject({ error: { type: "entitlement_write_failed" } });
        for (const key of keys) expect(await storage.get(key)).toBeDefined();
      });
    },
  );

  it("applies an initial sandbox subscription signed with the previous binding secret", async () => {
    metadata.subscription = null;
    const previousSecret = "old_sandbox_binding";
    const rotatedEnv = paddleEnvForStoredLane(
      {
        ...sandboxEnv.PADDLE_ROOT_ENV!,
        PADDLE_SANDBOX_CHECKOUT_BINDING_PREVIOUS_SECRET: previousSecret,
      },
      "sandbox",
    );
    const event = await sandboxEvent();
    event.data.custom_data = await buildPaddleCheckoutCustomData("user_lane", {
      ...sandboxEnv,
      PADDLE_CHECKOUT_BINDING_SECRET: previousSecret,
    });

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, rotatedEnv)).toEqual({
      applied: true,
    });
    expect(metadata.subscription).toMatchObject({
      paddleSubscriptionId: "sub_sandbox_new",
      paddleEnvironment: "sandbox",
      status: "active",
    });
  });

  it("every live write sends an explicit null marker, even within the live lane", async () => {
    delete metadata.subscription.paddleEnvironment;
    metadata.subscription.paddleSubscriptionId = "sub_live";
    metadata.subscription.paddleCustomerId = "ctm_live";

    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: await liveEvent() }, env),
    ).toEqual({ applied: true });

    const patch = mocks.updateUserMetadata.mock.calls.at(-1)?.[1]?.privateMetadata;
    expect(patch.subscription).toHaveProperty("paddleEnvironment", null);
    expect(metadata.subscription).not.toHaveProperty("paddleEnvironment");
  });
});

// ---------------------------------------------------------------------------
// Pass 4: lane lock (transitions refused, not reconciled), Paddle's raw paused
// status, and environment-scoped replay tombstones.
// ---------------------------------------------------------------------------

const lockSandboxEnv = paddleEnvForStoredLane(
  {
    ...env,
    PADDLE_LANE: undefined,
    PADDLE_ENV: "sandbox",
    PADDLE_SANDBOX_API_KEY: "test_sandbox_key",
    PADDLE_SANDBOX_WEBHOOK_SECRET: "test_sandbox_secret",
    PADDLE_SANDBOX_STARTER_PRICE_ID: "pri_sandbox_starter",
    PADDLE_SANDBOX_PRO_PRICE_ID: "pri_sandbox_pro",
    PADDLE_SANDBOX_UNLIMITED_PRICE_ID: "pri_sandbox_unlimited",
  },
  "sandbox",
);

function memoryLedger(): PaddleOverageLedgerStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => Promise.resolve(data.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
    list: <T>(options?: { prefix?: string }) =>
      Promise.resolve(
        new Map([...data].filter(([k]) => !options?.prefix || k.startsWith(options.prefix))) as Map<
          string,
          T
        >,
      ),
    delete: (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      return Promise.resolve(true);
    },
  };
}

describe("lane lock: a sandbox-locked account never takes live subscription state", () => {
  async function variant(name: string): Promise<PaddleEvent> {
    const event = await liveEvent();
    switch (name) {
      case "older activation":
        event.occurredAt = "2026-10-10T12:00:00Z";
        event.eventType = "subscription.activated";
        break;
      case "newer cancellation":
        event.eventType = "subscription.canceled";
        event.data.status = "canceled";
        break;
      case "pause":
        event.eventType = "subscription.paused";
        event.data.status = "paused";
        break;
      case "unbound":
        event.data.custom_data = { clerkUserId: "user_lane" };
        metadata.subscription.paddleCustomerId = "ctm_live";
        break;
      case "superseded replay":
        event.data.id = "sub_live_old";
        break;
    }
    return event;
  }

  it.each([
    "verified purchase",
    "older activation",
    "newer cancellation",
    "pause",
    "unbound",
    "superseded replay",
  ])("refuses a live %s and writes nothing", async (name) => {
    const event = await variant(name);
    const previous = structuredClone(metadata);

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, env)).toEqual({
      ignored: "lane_locked",
    });
    expect(metadata).toEqual(previous);
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a sandbox event on an account locked to live (even a cancelled live plan)", async () => {
    metadata.subscription = {
      plan: "pro",
      status: "canceled",
      paddleStatus: "canceled",
      paddleSubscriptionId: "sub_live",
      paddleCustomerId: "ctm_sandbox_new",
      priceId: "pri_live_pro",
      paddleOccurredAt: "2026-10-11T12:00:00Z",
    };
    const event: PaddleEvent = {
      eventId: "evt_sandbox_new",
      eventType: "subscription.created",
      occurredAt: new Date(now).toISOString(),
      data: {
        id: "sub_sandbox_new",
        customer_id: "ctm_sandbox_new",
        status: "active",
        custom_data: await buildPaddleCheckoutCustomData("user_lane", lockSandboxEnv),
        items: [{ price: { id: "pri_sandbox_pro" }, quantity: 1 }],
      },
    };
    const previous = structuredClone(metadata);

    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event }, lockSandboxEnv),
    ).toEqual({ ignored: "lane_locked" });
    expect(metadata).toEqual(previous);
  });

  it("the first subscription locks the account's lane", async () => {
    metadata.subscription = { paddleCustomerId: "ctm_live" };
    delete metadata.paddleLane;

    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: await liveEvent() }, env),
    ).toEqual({ applied: true });
    expect(metadata.paddleLane).toBe("production");
    expect(storedPaddleLane(metadata.subscription)).toBe("production");
  });

  it("an explicit lock wins over a stored record from another lane", async () => {
    metadata.paddleLane = "production";
    delete metadata.subscription.paddleEnvironment;
    metadata.subscription.paddleSubscriptionId = "sub_live";
    metadata.subscription.paddleCustomerId = "ctm_live";
    const renewal = await liveEvent({ eventId: "evt_live_renew" });
    renewal.eventType = "subscription.updated";
    renewal.occurredAt = new Date(now + 1000).toISOString();

    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: renewal }, env),
    ).toEqual({ applied: true });
  });
});

describe("Paddle's paused status is preserved (pass-4 P1)", () => {
  const pausedLive = () => ({
    plan: "pro",
    // What the writer stores for a real subscription.paused event:
    status: "canceled",
    paddleStatus: "paused",
    paddleSubscriptionId: "sub_paused",
    paddleCustomerId: "ctm_live",
    priceId: "pri_live_pro",
    paddleOccurredAt: "2026-10-11T12:00:00Z",
  });

  beforeEach(() => {
    metadata.subscription = pausedLive();
    metadata.paddleLane = "production";
  });

  it("the writer stores paused as canceled for display and paused in paddleStatus", async () => {
    metadata.subscription = { ...pausedLive(), status: "active", paddleStatus: "active" };
    const pause = await liveEvent({ eventId: "evt_pause" });
    pause.eventType = "subscription.paused";
    pause.data.id = "sub_paused";
    pause.data.status = "paused";

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event: pause }, env)).toEqual({
      applied: true,
    });
    expect(metadata.subscription).toMatchObject({ status: "canceled", paddleStatus: "paused" });
  });

  it("a paused subscription is still live: a second subscription can't replace it", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      return Promise.resolve(
        Response.json({
          data: url.endsWith("/sub_paused")
            ? { customer_id: "ctm_live", status: "paused" }
            : { customer_id: "ctm_live", status: "active" },
        }),
      );
    });

    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: await liveEvent() }, env),
    ).toEqual({ stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("a resume event for the paused subscription is applied", async () => {
    const resume = await liveEvent({ eventId: "evt_resume" });
    resume.eventType = "subscription.resumed";
    resume.data.id = "sub_paused";
    resume.data.status = "active";

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event: resume }, env)).toEqual(
      { applied: true },
    );
    expect(metadata.subscription).toMatchObject({
      paddleSubscriptionId: "sub_paused",
      status: "active",
      paddleStatus: "active",
    });
  });
});

describe("replay tombstones survive a ledger retirement (pass-4 C)", () => {
  it("retiring a lane's ledger keeps its transaction ids as tombstones", async () => {
    const ledger = memoryLedger();
    await ledger.put(PADDLE_OVERAGE_CREDITS_STORAGE_KEY, [
      { eventId: "evt_a", transactionId: "txn_a", extraDrafts: 10, windowStart: 1 },
    ]);

    expect(await retireOverageLedgerWithTombstones(ledger, "sandbox", ["txn_clerk"])).toBe(1);

    expect(ledger.data.get(`${PADDLE_OVERAGE_TOMBSTONES_STORAGE_KEY_PREFIX}sandbox`)).toEqual([
      "txn_a",
      "txn_clerk",
    ]);
    expect(ledger.data.get(`${PADDLE_OVERAGE_TOMBSTONES_STORAGE_KEY_PREFIX}production`)).toBe(
      undefined,
    );
  });

  it("a redelivered old purchase in the same environment is never credited again", async () => {
    const ledger = memoryLedger();
    await ledger.put(`${PADDLE_OVERAGE_TOMBSTONES_STORAGE_KEY_PREFIX}sandbox`, ["txn_old"]);
    await ledger.put(PADDLE_OVERAGE_LEDGER_LANE_STORAGE_KEY, "sandbox");

    const result = await recordPaddleOverageInClerk(
      "user_lane",
      {
        now,
        eventId: "evt_replayed_purchase",
        transactionId: "txn_old",
        customerId: "ctm_sandbox",
        extraDrafts: 10,
        credits: [{ transactionItemId: null, extraDrafts: 10, amount: null }],
      },
      lockSandboxEnv,
      ledger,
    );

    expect(result).toEqual({ idempotent: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });
});
