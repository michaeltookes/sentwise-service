import { describe, it, expect } from "vitest";
import { buildAppDeepLink, isCallbackPath, renderCallbackPage } from "../src/callback";
import worker from "../src/index";
import type { Env } from "../src/config";

const env: Env = { CLERK_SECRET_KEY: "sk", ANTHROPIC_API_KEY: "ak", CLERK_PUBLISHABLE_KEY: "pk" };

describe("callback landing pages", () => {
  it("forwards only the allow-listed Clerk nonce to the app scheme", () => {
    const link = buildAppDeepLink(
      "/auth/callback",
      new URLSearchParams({ rotating_token_nonce: "abc 123", extra: "dropped" }),
    );
    expect(link).toBe("sentwise://oauth-callback?rotating_token_nonce=abc+123");
  });

  it("forwards the OpenRouter code", () => {
    const link = buildAppDeepLink("/openrouter/callback", new URLSearchParams({ code: "c0de" }));
    expect(link).toBe("sentwise://openrouter-callback?code=c0de");
  });

  it("returns null when the required parameter is missing or unknown path", () => {
    expect(buildAppDeepLink("/auth/callback", new URLSearchParams())).toBeNull();
    expect(buildAppDeepLink("/nope", new URLSearchParams({ code: "x" }))).toBeNull();
    expect(isCallbackPath("/v1/draft")).toBe(false);
  });

  it("renders an HTML page that redirects to the deep link and escapes values", () => {
    const res = renderCallbackPage(
      "/auth/callback",
      new URLSearchParams({ rotating_token_nonce: `"><script>alert(1)</script>` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the page from the worker and 400s when the nonce is missing", async () => {
    const ok = await worker.fetch(
      new Request("https://x/auth/callback?rotating_token_nonce=n1"),
      env,
    );
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("sentwise://oauth-callback?rotating_token_nonce=n1");
    expect(html).toContain("You&#39;re signed in");

    const bad = await worker.fetch(new Request("https://x/auth/callback"), env);
    expect(bad.status).toBe(400);

    const wrongMethod = await worker.fetch(
      new Request("https://x/auth/callback", { method: "POST" }),
      env,
    );
    expect(wrongMethod.status).toBe(405);
  });

  it("never echoes raw script from a hostile nonce into the page", async () => {
    const res = await worker.fetch(
      new Request(
        `https://x/auth/callback?rotating_token_nonce=${encodeURIComponent("</script><script>alert(1)</script>")}`,
      ),
      env,
    );
    const html = await res.text();
    expect(html).not.toContain("</script><script>alert(1)</script>");
  });
});
