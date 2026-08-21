import { describe, it, expect } from "vitest";
import { isCallbackPath } from "../src/callback";
import worker from "../src/index";
import type { Env } from "../src/config";

const env: Env = { CLERK_SECRET_KEY: "sk", ANTHROPIC_API_KEY: "ak", CLERK_PUBLISHABLE_KEY: "pk" };

describe("callback landing pages", () => {
  it("recognizes the two callback paths and nothing else", () => {
    expect(isCallbackPath("/auth/callback")).toBe(true);
    expect(isCallbackPath("/openrouter/callback")).toBe(true);
    expect(isCallbackPath("/v1/draft")).toBe(false);
  });

  it("renders a styled 200 HTML page (never JSON) with the client-side forwarder", async () => {
    const res = await worker.fetch(new Request("https://x/auth/callback"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("You're all set");
    // Reads BOTH query and fragment (Clerk returns the nonce in the fragment on HTTPS).
    expect(html).toContain("location.hash");
    expect(html).toContain("rotating_token_nonce");
    expect(html).toContain("sentwise://");
    expect(html).not.toContain('{"error"');
  });

  it("renders the OpenRouter page with its code param", async () => {
    const html = await (
      await worker.fetch(new Request("https://x/openrouter/callback"), env)
    ).text();
    expect(html).toContain("OpenRouter connected");
    expect(html).toContain('"code"');
  });

  it("405s a POST and 404s an unknown path", async () => {
    expect(
      (await worker.fetch(new Request("https://x/auth/callback", { method: "POST" }), env)).status,
    ).toBe(405);
    expect((await worker.fetch(new Request("https://x/nope"), env)).status).toBe(404);
  });
});
