import { describe, it, expect } from "vitest";
import { hashUserId } from "../src/analytics";

// S-I2 (security pass 2026-09-13): keyed HMAC vs unkeyed SHA-256 pseudonym.

const HEX64 = /^[0-9a-f]{64}$/;

async function expectedHmacHex(key: string, msg: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("hashUserId (S-I2)", () => {
  it("is a deterministic 64-char hex digest without a key (SHA-256 fallback)", async () => {
    const a = await hashUserId("user_1");
    const b = await hashUserId("user_1");
    expect(a).toMatch(HEX64);
    expect(a).toBe(b);
    expect(await hashUserId("user_2")).not.toBe(a);
  });

  it("uses keyed HMAC-SHA256 when a key is provided", async () => {
    const keyed = await hashUserId("user_1", "secret-key");
    expect(keyed).toMatch(HEX64);
    expect(keyed).toBe(await hashUserId("user_1", "secret-key")); // deterministic
    // Keyed output matches an independent HMAC computation.
    expect(keyed).toBe(await expectedHmacHex("secret-key", "user_1"));
  });

  it("keyed hash differs from the unkeyed hash and across keys (enabling breaks continuity)", async () => {
    const unkeyed = await hashUserId("user_1");
    expect(await hashUserId("user_1", "secret-key")).not.toBe(unkeyed);
    expect(await hashUserId("user_1", "key-a")).not.toBe(await hashUserId("user_1", "key-b"));
    expect(await hashUserId("user_1", "k")).not.toBe(await hashUserId("user_2", "k"));
  });
});
