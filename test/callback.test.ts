import { describe, it, expect } from "vitest";
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../src/config";
import worker from "../src/index";
import { isCallbackPath, normalizeCallbackFragment } from "../src/callback";

// The callback routes are static, unauthenticated landing pages: worker.fetch
// returns before it touches Clerk/Anthropic/the quota DO, so the base test env
// (dummy bindings from vitest.config.ts) is all these tests need.
const env: Env = {
  ...testEnv,
  CLERK_SECRET_KEY: "sk_test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CLERK_PUBLISHABLE_KEY: "pk_test",
};

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://sentwise-inference.example${path}`), env);
}

describe("OAuth callback landing pages (item 89)", () => {
  it("recognizes exactly the two callback paths", () => {
    expect(isCallbackPath("/auth/callback")).toBe(true);
    expect(isCallbackPath("/openrouter/callback")).toBe(true);
    expect(isCallbackPath("/v1/draft")).toBe(false);
    expect(isCallbackPath("/auth/callback/")).toBe(false);
    expect(isCallbackPath("/")).toBe(false);
  });

  it("GET /auth/callback returns a styled HTML page, never a 404/JSON", async () => {
    const res = await get("/auth/callback");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("You're all set");
    expect(html).toContain("You can close this tab.");
    expect(html).not.toContain('{"error"');
    expect(html).not.toContain("not_found");
  });

  it("GET /auth/callback forwards ONLY rotating_token_nonce + state to sentwise://oauth-callback", async () => {
    const html = await (await get("/auth/callback")).text();
    // The allow-list embedded in the page is exactly these two params, in order.
    expect(html).toContain('["rotating_token_nonce","state"]');
    // Forwards to the app's oauth-callback deep link over the sentwise scheme.
    expect(html).toContain('"sentwise://"');
    expect(html).toContain('"oauth-callback"');
    // Reads BOTH query and fragment (Clerk returns the nonce in the fragment on HTTPS).
    expect(html).toContain("location.search");
    expect(html).toContain("location.hash");
    // Values are percent-encoded through URLSearchParams, never interpolated.
    expect(html).toContain("new URLSearchParams");
  });

  it("parses Clerk hash-router fragments before reading the nonce", async () => {
    const html = await (await get("/auth/callback")).text();

    expect(normalizeCallbackFragment("#/?rotating_token_nonce=nonce-123&state=state-abc")).toBe(
      "rotating_token_nonce=nonce-123&state=state-abc",
    );
    expect(normalizeCallbackFragment("#rotating_token_nonce=nonce-123")).toBe(
      "rotating_token_nonce=nonce-123",
    );
    expect(html).toContain("var h = read(fragmentParams(location.hash));");
  });

  it("GET /openrouter/callback forwards ONLY code + state to sentwise://openrouter-callback", async () => {
    const res = await get("/openrouter/callback");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("OpenRouter connected");
    expect(html).toContain('["code","state"]');
    expect(html).toContain('"openrouter-callback"');
  });

  it("does not echo query params into the page (extras are ignored, not reflected)", async () => {
    const html = await (
      await get("/auth/callback?rotating_token_nonce=abc&state=xyz&evil=pwned&foo=bar")
    ).text();
    // The page is static; no request param value is reflected server-side, so an
    // attacker cannot smuggle an extra param's value into the HTML/JS.
    expect(html).not.toContain("pwned");
    expect(html).not.toContain("evil");
    expect(html).not.toContain("abc");
    expect(html).not.toContain("xyz");
  });

  it("cannot be used to inject script via a malicious param value", async () => {
    const injection = "</script><script>window.__pwned=1</script>";
    const html = await (
      await get(`/auth/callback?rotating_token_nonce=${encodeURIComponent(injection)}`)
    ).text();
    expect(html).not.toContain("window.__pwned");
    expect(html).not.toContain("</script><script>");
  });

  it("405s a non-GET method and 404s an unknown path", async () => {
    const post = await worker.fetch(
      new Request("https://sentwise-inference.example/auth/callback", { method: "POST" }),
      env,
    );
    expect(post.status).toBe(405);

    const unknown = await get("/nope");
    expect(unknown.status).toBe(404);
    const body = await unknown.json();
    expect(body).toMatchObject({ error: { type: "not_found" } });
  });
});
