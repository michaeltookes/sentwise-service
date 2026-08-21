import { describe, it, expect, vi } from "vitest";
import { forwardToAnthropic, parseDraftRequest } from "../src/anthropic";
import { ApiError } from "../src/errors";
import { DEFAULT_MODEL, DEFAULT_MAX_TOKENS, ANTHROPIC_API_URL } from "../src/config";
import type { Env } from "../src/config";

const env: Env = {
  CLERK_SECRET_KEY: "sk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
};

function anthropicOk() {
  return new Response(
    JSON.stringify({
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
      usage: { input_tokens: 12, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("parseDraftRequest", () => {
  it("accepts a well-formed body", () => {
    const req = parseDraftRequest({
      model: "claude-sonnet-4-6",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      temperature: 0.3,
    });
    expect(req.messages).toHaveLength(1);
    expect(req.system).toBe("be brief");
  });

  it("rejects a non-object body", () => {
    expect(() => parseDraftRequest(null)).toThrow(ApiError);
    expect(() => parseDraftRequest("nope")).toThrow(ApiError);
  });

  it("rejects empty or invalid messages", () => {
    expect(() => parseDraftRequest({ messages: [] })).toThrow(ApiError);
    expect(() => parseDraftRequest({ messages: [{ role: "system", content: "x" }] })).toThrow(
      ApiError,
    );
    expect(() => parseDraftRequest({ messages: [{ role: "user", content: 5 }] })).toThrow(ApiError);
  });

  it("rejects wrong-typed optional fields", () => {
    expect(() =>
      parseDraftRequest({ messages: [{ role: "user", content: "x" }], maxTokens: "big" }),
    ).toThrow(ApiError);
  });

  it("rejects a non-default model (cost guard)", () => {
    try {
      parseDraftRequest({ model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).type).toBe("invalid_request");
    }
    // The default model is accepted.
    expect(
      parseDraftRequest({ model: DEFAULT_MODEL, messages: [{ role: "user", content: "x" }] }).model,
    ).toBe(DEFAULT_MODEL);
  });

  it("clamps maxTokens into [1, DEFAULT_MAX_TOKENS]", () => {
    expect(
      parseDraftRequest({ messages: [{ role: "user", content: "x" }], maxTokens: 10_000_000 })
        .maxTokens,
    ).toBe(DEFAULT_MAX_TOKENS);
    expect(
      parseDraftRequest({ messages: [{ role: "user", content: "x" }], maxTokens: 0 }).maxTokens,
    ).toBe(1);
    expect(
      parseDraftRequest({ messages: [{ role: "user", content: "x" }], maxTokens: 256 }).maxTokens,
    ).toBe(256);
  });

  it("rejects an oversized request with 413 request_too_large", () => {
    const huge = "a".repeat(200_001);
    try {
      parseDraftRequest({ messages: [{ role: "user", content: huge }] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(413);
      expect((err as ApiError).type).toBe("request_too_large");
    }
    // Just under the limit (system + messages) is fine.
    expect(() =>
      parseDraftRequest({
        system: "a".repeat(100_000),
        messages: [{ role: "user", content: "b".repeat(99_999) }],
      }),
    ).not.toThrow();
  });
});

describe("forwardToAnthropic", () => {
  it("forwards a well-formed Anthropic request and maps the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk());
    const res = await forwardToAnthropic(
      { system: "sys", messages: [{ role: "user", content: "draft this" }], temperature: 0.4 },
      env,
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ANTHROPIC_API_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("sk-ant-test");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(DEFAULT_MODEL);
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.system).toBe("sys");
    expect(body.temperature).toBe(0.4);
    expect(body.messages).toEqual([{ role: "user", content: "draft this" }]);

    expect(res.text).toBe("Hello world");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  });

  it("honors explicit model and maxTokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicOk());
    await forwardToAnthropic(
      { model: "claude-opus-4-8", maxTokens: 256, messages: [{ role: "user", content: "x" }] },
      env,
      fetchMock,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.max_tokens).toBe(256);
    expect("system" in body).toBe(false);
    expect("temperature" in body).toBe(false);
  });

  it("maps Anthropic 429 to a clean rate_limited error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: "rate_limit_error", message: "secret detail" } }),
          { status: 429 },
        ),
      );
    await expect(
      forwardToAnthropic(
        { messages: [{ role: "user", content: "x" }] },
        env,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 429, type: "rate_limited" });
  });

  it("maps an auth failure of OUR key to a generic upstream error (never 401 to the user)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }),
          { status: 401 },
        ),
      );
    await expect(
      forwardToAnthropic(
        { messages: [{ role: "user", content: "x" }] },
        env,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 502, type: "upstream_error" });
  });

  it("maps a network failure to upstream_unavailable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      forwardToAnthropic(
        { messages: [{ role: "user", content: "x" }] },
        env,
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 502, type: "upstream_unavailable" });
  });
});
