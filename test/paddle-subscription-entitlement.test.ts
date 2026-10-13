import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/config";
import type { PaddleEvent } from "../src/paddle";
import { buildPaddleCheckoutCustomData } from "../src/paddle-account";
import { recordPaddleSubscriptionInClerk } from "../src/paddle-subscription-entitlement";
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
  it("removes sandbox overage and its replay state when a verified live subscription replaces it", async () => {
    const result = await recordPaddleSubscriptionInClerk(
      "user_lane",
      { now, event: await liveEvent() },
      env,
    );

    expect(result).toEqual({ applied: true });
    expect(metadata.quota).toEqual({
      monthlyDraftLimit: 120,
      monthlyTokenLimit: 500000,
      enforcement: "hard",
    });
    expect(metadata.subscription).toMatchObject({
      paddleSubscriptionId: "sub_live",
      paddleCustomerId: "ctm_live",
      status: "active",
      supersededPaddleSubscriptionIds: ["sub_live_old", "sub_sandbox"],
    });
    expect(metadata.subscription).not.toHaveProperty("paddleEnvironment");
    expect(storedPaddleLane(metadata.subscription)).toBe("production");
    expect(metadata.unrelated).toEqual({ keep: true });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.paddle.com/subscriptions/sub_live",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test_live_key" }),
      }),
    );
  });

  it.each(["active", "canceled"])("rejects an older live %s event", async (status) => {
    const event = await liveEvent({ occurredAt: "2026-10-10T12:00:00Z" });
    event.eventType = status === "canceled" ? "subscription.canceled" : "subscription.activated";
    event.data.status = status;
    const previous = structuredClone(metadata);

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, env)).toEqual({
      stale: true,
    });
    expect(metadata).toEqual(previous);
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["canceled", "paused"])(
    "rejects a newer live %s event even when Paddle confirms that status",
    async (status) => {
      const event = await liveEvent();
      event.eventType = `subscription.${status}`;
      event.data.status = status;
      vi.mocked(fetch).mockResolvedValue(
        Response.json({ data: { customer_id: "ctm_live", status } }),
      );

      expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, env)).toEqual({
        stale: true,
      });
      expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    },
  );

  it.each([
    { customer_id: "ctm_live", status: "canceled" },
    { customer_id: "ctm_unrelated", status: "active" },
  ])("rejects a live event whose Paddle snapshot disagrees: %j", async (snapshot) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ data: snapshot }));
    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: await liveEvent() }, env),
    ).toEqual({ stale: true });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
  });

  it("requires a checkout binding even when the incoming customer matches stored metadata", async () => {
    metadata.subscription.paddleCustomerId = "ctm_live";
    const event = await liveEvent();
    event.data.custom_data = { clerkUserId: "user_lane" };

    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, env)).toEqual({
      stale: true,
    });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects replays of superseded live subscriptions while the stored lane is sandbox", async () => {
    const event = await liveEvent();
    event.data.id = "sub_live_old";
    expect(await recordPaddleSubscriptionInClerk("user_lane", { now, event }, env)).toEqual({
      stale: true,
    });
    expect(mocks.updateUserMetadata).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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

  async function expectEmptyLedger(storage: DurableObjectStorage) {
    expect(await storage.get(PADDLE_OVERAGE_CREDITS_STORAGE_KEY)).toBeUndefined();
    expect(await storage.get(PADDLE_OVERAGE_PENDING_REVERSALS_STORAGE_KEY)).toBeUndefined();
    expect((await storage.list({ prefix: PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX })).size).toBe(0);
    expect(
      (await storage.list({ prefix: PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX })).size,
    ).toBe(0);
    expect(await storage.get("unrelated")).toEqual({ keep: true });
  }

  it("clears durable ledgers in both directions and keeps an old refund from consuming new credits", async () => {
    await withLedger(async (storage, quota) => {
      await seedLedger(storage);
      expect(
        await postQuota(quota, "/paddle-subscription", { now, event: await liveEvent() }),
      ).toEqual({ applied: true });
      await expectEmptyLedger(storage);
      expect(await storage.get(PADDLE_OVERAGE_LEDGER_LANE_STORAGE_KEY)).toBe("production");

      // After the live subscription is canceled, a new sandbox subscription
      // starts in the same month and uses the original sandbox customer.
      metadata.subscription.status = "canceled";
      await seedLedger(storage);
      const event = await sandboxEvent();
      event.data.customer_id = "ctm_sandbox";
      vi.mocked(fetch).mockResolvedValue(
        Response.json({ data: { customer_id: "ctm_sandbox", status: "active" } }),
      );
      expect(await postQuota(quota, "/paddle-subscription", { now, event }, "sandbox")).toEqual({
        applied: true,
      });
      await expectEmptyLedger(storage);
      expect(await storage.get(PADDLE_OVERAGE_LEDGER_LANE_STORAGE_KEY)).toBe("sandbox");

      expect(
        await postQuota(
          quota,
          "/paddle-overage",
          {
            now,
            eventId: "evt_new_purchase",
            transactionId: "txn_new_purchase",
            customerId: "ctm_sandbox",
            extraDrafts: 40,
            credits: [{ transactionItemId: null, extraDrafts: 40, amount: null }],
          },
          "sandbox",
        ),
      ).toEqual({ applied: true, extraDrafts: 40 });
      expect(
        await postQuota(
          quota,
          "/paddle-overage-reversal",
          {
            now,
            eventId: "evt_old_refund",
            adjustmentId: "adj_old_refund",
            transactionId: "txn_sandbox",
            customerId: "ctm_sandbox",
            action: "refund",
            adjustmentType: "full",
            items: [],
          },
          "sandbox",
        ),
      ).toEqual({ pending: true });
      expect(metadata.quota.extraDrafts).toBe(40);
    });
  });

  it.each(["same-lane", "stale", "Clerk failure"])(
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
          event = await liveEvent({ occurredAt: "2026-10-10T12:00:00Z" });
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

  it.each(["subscription retry", "purchase", "refund"])(
    "repairs interrupted ledger cleanup before a subsequent %s",
    async (next) => {
      await withLedger(async (storage, quota) => {
        await seedLedger(storage);
        const event = await liveEvent();
        const ledgerStore = {
          get: storage.get.bind(storage),
          put: storage.put.bind(storage),
          list: storage.list.bind(storage),
          delete: vi.fn(storage.delete.bind(storage)),
        };
        // Clerk succeeds, then the first durable cleanup fails. Re-enter through
        // AccountQuota to exercise recovery using the persisted lane marker.
        ledgerStore.delete.mockRejectedValueOnce(new Error("storage unavailable"));
        await expect(
          recordPaddleSubscriptionInClerk("user_lane", { now, event }, env, ledgerStore),
        ).rejects.toThrow("storage unavailable");
        expect(storedPaddleLane(metadata.subscription)).toBe("production");
        expect(await storage.get(PADDLE_OVERAGE_LEDGER_LANE_STORAGE_KEY)).toBe("sandbox");

        if (next === "subscription retry") {
          expect(await postQuota(quota, "/paddle-subscription", { now, event })).toEqual({
            idempotent: true,
          });
          await expectEmptyLedger(storage);
        } else if (next === "purchase") {
          expect(
            await postQuota(quota, "/paddle-overage", {
              now,
              eventId: "evt_live_purchase",
              transactionId: "txn_live_purchase",
              customerId: "ctm_live",
              extraDrafts: 40,
              credits: [{ transactionItemId: null, extraDrafts: 40, amount: null }],
            }),
          ).toEqual({ applied: true, extraDrafts: 40 });
          const credits = await storage.list<{ transactionId: string }>({
            prefix: PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX,
          });
          expect([...credits.values()].map((credit) => credit.transactionId)).toEqual([
            "txn_live_purchase",
          ]);
          expect(
            (await storage.list({ prefix: PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX }))
              .size,
          ).toBe(0);
        } else {
          expect(
            await postQuota(quota, "/paddle-overage-reversal", {
              now,
              eventId: "evt_live_refund",
              adjustmentId: "adj_live_refund",
              transactionId: "txn_sandbox",
              customerId: "ctm_live",
              action: "refund",
              adjustmentType: "full",
              items: [],
            }),
          ).toEqual({ pending: true });
          expect(
            (await storage.list({ prefix: PADDLE_OVERAGE_CREDIT_STORAGE_KEY_PREFIX })).size,
          ).toBe(0);
          const pending = await storage.list<{ adjustmentId: string }>({
            prefix: PADDLE_OVERAGE_PENDING_REVERSAL_STORAGE_KEY_PREFIX,
          });
          expect([...pending.values()].map((item) => item.adjustmentId)).toEqual([
            "adj_live_refund",
          ]);
          expect(metadata.quota.extraDrafts).toBeUndefined();
        }
        expect(await storage.get(PADDLE_OVERAGE_LEDGER_LANE_STORAGE_KEY)).toBe("production");
        expect(await storage.get("unrelated")).toEqual({ keep: true });
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

  it("sandbox -> live: the merged record has live ids and no sandbox stamp", async () => {
    expect(
      await recordPaddleSubscriptionInClerk("user_lane", { now, event: await liveEvent() }, env),
    ).toEqual({ applied: true });

    expect(metadata.subscription).toMatchObject({
      paddleSubscriptionId: "sub_live",
      paddleCustomerId: "ctm_live",
    });
    expect(storedPaddleLane(metadata.subscription)).toBe("production");
  });

  it("live -> sandbox: a sandbox purchase after a cancelled live plan is stamped sandbox", async () => {
    metadata.subscription = {
      plan: "pro",
      status: "canceled",
      paddleSubscriptionId: "sub_live",
      paddleCustomerId: "ctm_live",
      priceId: "pri_live_pro",
      paddleOccurredAt: "2026-10-11T12:00:00Z",
    };
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ data: { customer_id: "ctm_sandbox_new", status: "active" } }),
    );

    expect(
      await recordPaddleSubscriptionInClerk(
        "user_lane",
        { now, event: await sandboxEvent() },
        sandboxEnv,
      ),
    ).toEqual({ applied: true });

    expect(metadata.subscription).toMatchObject({
      paddleSubscriptionId: "sub_sandbox_new",
      paddleCustomerId: "ctm_sandbox_new",
      paddleEnvironment: "sandbox",
    });
    // The existing quota represents the canceled live plan's paid overage.
    // None of its credits, transaction ledger, or replay state become sandbox data.
    expect(metadata.quota).toEqual({
      monthlyDraftLimit: 120,
      monthlyTokenLimit: 500000,
      enforcement: "hard",
    });
    expect(metadata.unrelated).toEqual({ keep: true });
    for (const call of vi.mocked(fetch).mock.calls) {
      const target = call[0];
      const url = typeof target === "string" || target instanceof URL ? String(target) : target.url;
      expect(url).toContain("sandbox-api.paddle.com");
    }
  });

  it("live -> sandbox: a sandbox event never overwrites a live plan in force", async () => {
    metadata.subscription = {
      plan: "pro",
      status: "active",
      paddleSubscriptionId: "sub_live",
      paddleCustomerId: "ctm_live",
      priceId: "pri_live_pro",
      paddleOccurredAt: "2026-10-11T12:00:00Z",
    };
    const previous = structuredClone(metadata);

    expect(
      await recordPaddleSubscriptionInClerk(
        "user_lane",
        { now, event: await sandboxEvent() },
        sandboxEnv,
      ),
    ).toEqual({ stale: true });
    expect(metadata).toEqual(previous);
  });
});
