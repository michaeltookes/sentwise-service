import { beforeEach, describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import type { PaddleEvent } from "../src/paddle";
import { buildPaddleCheckoutCustomData } from "../src/paddle-account";
import { recordPaddleSubscriptionInClerk } from "../src/paddle-subscription-entitlement";
import { paddleEnvForStoredLane, storedPaddleLane } from "../src/paddle-env";

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
