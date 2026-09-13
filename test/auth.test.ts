import { describe, it, expect, beforeAll } from "vitest";
import { verifyToken } from "@clerk/backend";
import { parseAuthorizedParties } from "../src/auth";

// S-L1 (security pass 2026-09-13): Clerk `authorizedParties` support.
//
// This file does NOT mock @clerk/backend — it exercises the REAL verifyToken azp
// behavior so we know exactly how the rollout will treat native-app session
// tokens (which may carry no/odd `azp`). Verification is networkless: we sign a
// token with a locally generated RSA key and hand verifyToken the matching PEM
// public key via `jwtKey`, so no JWKS fetch happens.

describe("parseAuthorizedParties (S-L1)", () => {
  it("returns undefined when unset (verification unchanged)", () => {
    expect(parseAuthorizedParties(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty or whitespace-only value", () => {
    expect(parseAuthorizedParties("")).toBeUndefined();
    expect(parseAuthorizedParties("   ")).toBeUndefined();
    expect(parseAuthorizedParties(",, ,")).toBeUndefined();
  });

  it("splits, trims, drops empties, and de-duplicates", () => {
    expect(parseAuthorizedParties("a")).toEqual(["a"]);
    expect(parseAuthorizedParties("a,b")).toEqual(["a", "b"]);
    expect(parseAuthorizedParties(" a , b ,, a ")).toEqual(["a", "b"]);
  });
});

// --- Real RSA key + JWT signer (networkless verifyToken via jwtKey) ------------

let privateKey: CryptoKey;
let pem: string;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signToken(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: "test" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

function basePayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    sub: "user_azp_test",
    iat: nowSec - 60,
    nbf: nowSec - 60,
    exp: nowSec + 3600,
    ...extra,
  };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...spki));
  pem = `-----BEGIN PUBLIC KEY-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----`;
});

describe("@clerk/backend verifyToken authorizedParties behavior (S-L1)", () => {
  it("accepts a token whose azp is in the allow-list", async () => {
    const token = await signToken(basePayload({ azp: "sentwise-app" }));
    const claims = await verifyToken(token, {
      jwtKey: pem,
      authorizedParties: ["sentwise-app", "other-client"],
    });
    expect(claims.sub).toBe("user_azp_test");
  });

  it("rejects a token whose azp is NOT in the allow-list", async () => {
    const token = await signToken(basePayload({ azp: "evil-client" }));
    await expect(
      verifyToken(token, { jwtKey: pem, authorizedParties: ["sentwise-app"] }),
    ).rejects.toBeTruthy();
  });

  // Rollout hazard: in @clerk/backend 3.16.x a token WITHOUT an `azp` claim is
  // REJECTED once authorizedParties is set (`!azp` fails the assertion). Native
  // session tokens can lack azp, so the cutover must confirm the app's tokens
  // carry a matching azp BEFORE setting CLERK_AUTHORIZED_PARTIES.
  it("rejects an azp-absent token when the allow-list is set", async () => {
    const token = await signToken(basePayload()); // no azp
    await expect(
      verifyToken(token, { jwtKey: pem, authorizedParties: ["sentwise-app"] }),
    ).rejects.toBeTruthy();
  });

  it("accepts an azp-absent token when no allow-list is configured (unchanged behavior)", async () => {
    const token = await signToken(basePayload()); // no azp
    const claims = await verifyToken(token, { jwtKey: pem });
    expect(claims.sub).toBe("user_azp_test");
  });

  it("accepts an azp-present token when no allow-list is configured", async () => {
    const token = await signToken(basePayload({ azp: "anything" }));
    const claims = await verifyToken(token, { jwtKey: pem });
    expect(claims.sub).toBe("user_azp_test");
  });
});
