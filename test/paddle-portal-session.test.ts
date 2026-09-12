import { describe, it, expect, vi, afterEach } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import { createPaddlePortalSession, selectPortalSessionUrl } from "../src/paddle-api";

const env: Env = {
  ...testEnv,
  CLERK_SECRET_KEY: "sk_test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
  PADDLE_API_KEY: "pdl_apikey",
  PADDLE_API_BASE: "https://sandbox-api.paddle.com",
};

const SUB = "sub_123";
const OTHER_SUB = "sub_999";

function urls(overrides: Record<string, unknown> = {}) {
  return {
    general: { overview: "https://portal.paddle.com/overview" },
    subscriptions: [
      {
        id: SUB,
        cancel_subscription: "https://portal.paddle.com/cancel/sub_123",
        update_subscription_payment_method: "https://portal.paddle.com/update/sub_123",
      },
    ],
    ...overrides,
  };
}

function portalSessionResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selectPortalSessionUrl", () => {
  it("maps update_payment_method to the subscription's payment-method deep link", () => {
    expect(selectPortalSessionUrl(urls(), SUB, "update_payment_method")).toBe(
      "https://portal.paddle.com/update/sub_123",
    );
  });

  it("maps cancel to the subscription's cancel deep link", () => {
    expect(selectPortalSessionUrl(urls(), SUB, "cancel")).toBe(
      "https://portal.paddle.com/cancel/sub_123",
    );
  });

  it("matches the subscription entry by id among several", () => {
    const many = urls({
      subscriptions: [
        {
          id: OTHER_SUB,
          cancel_subscription: "https://portal.paddle.com/cancel/sub_999",
          update_subscription_payment_method: "https://portal.paddle.com/update/sub_999",
        },
        {
          id: SUB,
          cancel_subscription: "https://portal.paddle.com/cancel/sub_123",
          update_subscription_payment_method: "https://portal.paddle.com/update/sub_123",
        },
      ],
    });
    expect(selectPortalSessionUrl(many, SUB, "cancel")).toBe(
      "https://portal.paddle.com/cancel/sub_123",
    );
  });

  it("falls back to general.overview when no per-subscription entry matches", () => {
    expect(selectPortalSessionUrl(urls(), OTHER_SUB, "cancel")).toBe(
      "https://portal.paddle.com/overview",
    );
  });

  it("falls back to overview when the matched entry lacks the requested link", () => {
    const noCancel = urls({
      subscriptions: [{ id: SUB, update_subscription_payment_method: "https://x/update" }],
    });
    expect(selectPortalSessionUrl(noCancel, SUB, "cancel")).toBe(
      "https://portal.paddle.com/overview",
    );
  });

  it("rejects a non-https deep link and falls back to overview", () => {
    const insecure = urls({
      subscriptions: [{ id: SUB, cancel_subscription: "http://portal.paddle.com/cancel" }],
    });
    expect(selectPortalSessionUrl(insecure, SUB, "cancel")).toBe(
      "https://portal.paddle.com/overview",
    );
  });

  it("returns null when neither a matching link nor a valid overview exists", () => {
    expect(selectPortalSessionUrl({ subscriptions: [] }, SUB, "cancel")).toBeNull();
    expect(selectPortalSessionUrl(null, SUB, "cancel")).toBeNull();
  });
});

describe("createPaddlePortalSession", () => {
  it("POSTs to the portal-sessions endpoint scoped to the subscription", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(portalSessionResponse({ data: { urls: urls() } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const url = await createPaddlePortalSession(env, "ctm_123", SUB, "cancel");

    expect(url).toBe("https://portal.paddle.com/cancel/sub_123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sandbox-api.paddle.com/customers/ctm_123/portal-sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer pdl_apikey" }),
        body: JSON.stringify({ subscription_ids: [SUB] }),
      }),
    );
  });

  it("returns null (for fallback) when Paddle responds non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(portalSessionResponse({ error: {} }, 500))),
    );
    expect(await createPaddlePortalSession(env, "ctm_123", SUB, "cancel")).toBeNull();
  });

  it("returns null (for fallback) when the fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network"))),
    );
    expect(await createPaddlePortalSession(env, "ctm_123", SUB, "cancel")).toBeNull();
  });

  it("returns null when no API key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const noKey: Env = { ...env, PADDLE_API_KEY: undefined };
    expect(await createPaddlePortalSession(noKey, "ctm_123", SUB, "cancel")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
