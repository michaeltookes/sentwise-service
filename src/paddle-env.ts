// 123 — Paddle sandbox lane (QA purchase path).
//
// One Worker serves both lanes. PADDLE_ENV decides whether the sandbox lane
// exists at all; the account's primary email decides who may use it:
//
//   PADDLE_ENV unset        -> legacy: env used as configured, no sandbox lane.
//   PADDLE_ENV=production   -> everyone on the live Paddle API + live secrets/prices.
//   PADDLE_ENV=sandbox      -> @prowlqa.dev accounts on the sandbox API base,
//                              PADDLE_SANDBOX_* key/secret/prices; everyone
//                              else still on production.
//
// The lane env is built by REPLACING the Paddle fields, never by layering, so a
// sandbox request can never fall back to a production key, secret, or price id
// (and vice versa). Production accounts can never be routed to the sandbox lane:
// paddleLaneForEmail() is the single gate and it requires both conditions.

import { PADDLE_LIVE_API_BASE, PADDLE_SANDBOX_API_BASE, type Env } from "./config";

export type PaddleLane = "sandbox" | "production";

/** QA accounts live on this exact domain (no subdomains, no look-alikes). */
export const QA_ACCOUNT_EMAIL_DOMAIN = "prowlqa.dev";

/** Internal Worker -> AccountQuota DO header carrying the resolved lane. */
export const PADDLE_LANE_HEADER = "x-sentwise-paddle-lane";

type PaddleEnvSource = Partial<Env>;

/** "production" | "sandbox" when PADDLE_ENV is set to one of them, else null (legacy). */
export function configuredPaddleEnv(env: PaddleEnvSource): PaddleLane | null {
  const raw = typeof env.PADDLE_ENV === "string" ? env.PADDLE_ENV.trim().toLowerCase() : "";
  if (raw === "sandbox") return "sandbox";
  if (raw === "production") return "production";
  return null;
}

/** True only when PADDLE_ENV is exactly "sandbox" (case/whitespace-insensitive). */
export function sandboxLaneEnabled(env: PaddleEnvSource): boolean {
  return configuredPaddleEnv(env) === "sandbox";
}

/** True when the address is on exactly the QA domain. */
export function isQaAccountEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at !== trimmed.indexOf("@")) return false;
  return trimmed.slice(at + 1) === QA_ACCOUNT_EMAIL_DOMAIN;
}

/** The single gate: sandbox only when the service is in sandbox AND the account is QA. */
export function paddleLaneForEmail(
  env: PaddleEnvSource,
  email: string | null | undefined,
): PaddleLane {
  return sandboxLaneEnabled(env) && isQaAccountEmail(email) ? "sandbox" : "production";
}

/** Parse the internal lane header. Anything but "sandbox" is production. */
export function paddleLaneFromHeader(value: string | null | undefined): PaddleLane {
  return value === "sandbox" ? "sandbox" : "production";
}

/**
 * The Env a request in `lane` must use. A sandbox lane request on a Worker whose
 * PADDLE_ENV is not "sandbox" is downgraded to production — the header (or any
 * caller) can never switch the lane on by itself.
 */
export function paddleEnvForLane(env: Env, lane: PaddleLane): Env {
  const mode = configuredPaddleEnv(env);
  if (lane === "sandbox" && mode === "sandbox") {
    return {
      ...env,
      PADDLE_LANE: "sandbox",
      PADDLE_API_BASE: PADDLE_SANDBOX_API_BASE,
      PADDLE_API_KEY: env.PADDLE_SANDBOX_API_KEY,
      PADDLE_WEBHOOK_SECRET: env.PADDLE_SANDBOX_WEBHOOK_SECRET,
      PADDLE_CHECKOUT_BINDING_SECRET: env.PADDLE_SANDBOX_CHECKOUT_BINDING_SECRET,
      PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET: undefined,
      PADDLE_STARTER_PRICE_ID: env.PADDLE_SANDBOX_STARTER_PRICE_ID,
      PADDLE_PRO_PRICE_ID: env.PADDLE_SANDBOX_PRO_PRICE_ID,
      PADDLE_UNLIMITED_PRICE_ID: env.PADDLE_SANDBOX_UNLIMITED_PRICE_ID,
      EXTRA_DRAFTS_PRICE_ID: env.PADDLE_SANDBOX_EXTRA_DRAFTS_PRICE_ID,
    };
  }
  if (mode === null) {
    // Legacy deployments (PADDLE_ENV unset) keep their configuration untouched.
    return { ...env, PADDLE_LANE: "production" };
  }
  // Explicit production: always the live API base, whatever PADDLE_API_BASE says.
  return { ...env, PADDLE_LANE: "production", PADDLE_API_BASE: PADDLE_LIVE_API_BASE };
}

/** What the app needs to open the right checkout for this account (GET /v1/paddle/config). */
export interface PaddleClientConfig {
  environment: PaddleLane;
  clientSideToken?: string;
  prices?: { starter: string; pro: string; unlimited: string };
}

/**
 * The client-facing lane description. Production returns only the environment —
 * the app keeps its embedded live token/prices — so a production account's
 * response never contains a sandbox token or price id. Sandbox returns the
 * sandbox token and price ids only when all of them are configured; otherwise
 * it reports production so the app never opens a half-configured sandbox.
 */
export function paddleClientConfig(env: Env, lane: PaddleLane): PaddleClientConfig {
  if (lane !== "sandbox" || !sandboxLaneEnabled(env)) return { environment: "production" };
  const token = nonEmpty(env.PADDLE_SANDBOX_CLIENT_TOKEN);
  const starter = nonEmpty(env.PADDLE_SANDBOX_STARTER_PRICE_ID);
  const pro = nonEmpty(env.PADDLE_SANDBOX_PRO_PRICE_ID);
  const unlimited = nonEmpty(env.PADDLE_SANDBOX_UNLIMITED_PRICE_ID);
  if (!token || !starter || !pro || !unlimited) return { environment: "production" };
  return { environment: "sandbox", clientSideToken: token, prices: { starter, pro, unlimited } };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
