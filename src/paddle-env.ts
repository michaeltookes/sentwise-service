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
 * PADDLE_ENV is not "sandbox" is downgraded to production: this is the entry
 * gate for NEW sandbox activity (checkout, /v1/me). Work on objects that already
 * exist in the sandbox (a reservation or subscription created there) uses
 * paddleEnvForStoredLane instead, which never downgrades.
 */
export function paddleEnvForLane(env: Env, lane: PaddleLane): Env {
  const root = rootPaddleEnv(env);
  if (lane === "sandbox" && configuredPaddleEnv(root) === "sandbox") {
    return sandboxEnv(root);
  }
  return productionEnv(root);
}

/**
 * The Env for an object that was CREATED in `lane` (a pending checkout
 * reservation, a stored subscription, a signed sandbox webhook). Routes by where
 * the object lives, whatever PADDLE_ENV says now, so a sandbox transaction is
 * never looked up on (and mistaken as "gone" by) the live API and vice versa.
 * Missing sandbox credentials make the sandbox calls fail closed.
 */
export function paddleEnvForStoredLane(env: Env, lane: PaddleLane): Env {
  const root = rootPaddleEnv(env);
  return lane === "sandbox" ? sandboxEnv(root) : productionEnv(root);
}

/** The unresolved Worker env behind a lane env (or the env itself). */
export function rootPaddleEnv(env: Env): Env {
  return env.PADDLE_ROOT_ENV ?? env;
}

function sandboxEnv(root: Env): Env {
  return {
    ...root,
    PADDLE_ROOT_ENV: root,
    PADDLE_LANE: "sandbox",
    PADDLE_API_BASE: PADDLE_SANDBOX_API_BASE,
    PADDLE_API_KEY: root.PADDLE_SANDBOX_API_KEY,
    PADDLE_WEBHOOK_SECRET: root.PADDLE_SANDBOX_WEBHOOK_SECRET,
    PADDLE_CHECKOUT_BINDING_SECRET: root.PADDLE_SANDBOX_CHECKOUT_BINDING_SECRET,
    PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET: root.PADDLE_SANDBOX_CHECKOUT_BINDING_PREVIOUS_SECRET,
    PADDLE_STARTER_PRICE_ID: root.PADDLE_SANDBOX_STARTER_PRICE_ID,
    PADDLE_PRO_PRICE_ID: root.PADDLE_SANDBOX_PRO_PRICE_ID,
    PADDLE_UNLIMITED_PRICE_ID: root.PADDLE_SANDBOX_UNLIMITED_PRICE_ID,
    EXTRA_DRAFTS_PRICE_ID: root.PADDLE_SANDBOX_EXTRA_DRAFTS_PRICE_ID,
  };
}

function productionEnv(root: Env): Env {
  if (configuredPaddleEnv(root) === null) {
    // Legacy deployments (PADDLE_ENV unset) keep their configuration untouched.
    return { ...root, PADDLE_ROOT_ENV: root, PADDLE_LANE: "production" };
  }
  // Explicit production: always the live API base, whatever PADDLE_API_BASE says.
  return {
    ...root,
    PADDLE_ROOT_ENV: root,
    PADDLE_LANE: "production",
    PADDLE_API_BASE: PADDLE_LIVE_API_BASE,
  };
}

/** The lane an env was resolved to (unresolved envs are production). */
export function laneOfEnv(env: Partial<Env>): PaddleLane {
  return env.PADDLE_LANE === "sandbox" ? "sandbox" : "production";
}

/**
 * The environment a stored Paddle object (subscription record or checkout
 * reservation) was created in. Only an explicit "sandbox" stamp is sandbox;
 * records written before item 123 are production.
 */
export function storedPaddleLane(record: unknown): PaddleLane {
  if (typeof record !== "object" || record === null) return "production";
  return (record as Record<string, unknown>).paddleEnvironment === "sandbox"
    ? "sandbox"
    : "production";
}

/**
 * True when every value the sandbox lane needs is configured: API key, webhook
 * secret, client token, and three distinct tier price ids. An incomplete lane
 * fails closed (checkout unavailable for QA accounts) instead of quietly
 * advertising production while the server routes to the sandbox.
 */
export function sandboxLaneComplete(env: Env): boolean {
  const root = rootPaddleEnv(env);
  const prices = [
    nonEmpty(root.PADDLE_SANDBOX_STARTER_PRICE_ID),
    nonEmpty(root.PADDLE_SANDBOX_PRO_PRICE_ID),
    nonEmpty(root.PADDLE_SANDBOX_UNLIMITED_PRICE_ID),
  ];
  return (
    !!nonEmpty(root.PADDLE_SANDBOX_API_KEY) &&
    !!nonEmpty(root.PADDLE_SANDBOX_WEBHOOK_SECRET) &&
    !!nonEmpty(root.PADDLE_SANDBOX_CLIENT_TOKEN) &&
    prices.every((p) => p !== null) &&
    new Set(prices).size === 3
  );
}

/**
 * Whether the sandbox can matter for any account: the lane is on, or sandbox
 * credentials are still configured (so stranded sandbox objects can be
 * serviced). When false, every account is production and no lookup is needed.
 */
export function sandboxInPlay(env: Env): boolean {
  const root = rootPaddleEnv(env);
  return (
    sandboxLaneEnabled(root) ||
    !!nonEmpty(root.PADDLE_SANDBOX_API_KEY) ||
    !!nonEmpty(root.PADDLE_SANDBOX_WEBHOOK_SECRET)
  );
}

/** Whether the sandbox webhook destination should accept deliveries at all. */
export function sandboxWebhookEnabled(env: Env): boolean {
  const root = rootPaddleEnv(env);
  return sandboxLaneEnabled(root) || !!nonEmpty(root.PADDLE_SANDBOX_WEBHOOK_SECRET);
}

/** What the app needs to open the right checkout for this account (GET /v1/me `billing`). */
export interface PaddleClientConfig {
  environment: PaddleLane;
  checkoutAvailable: boolean;
  clientSideToken?: string;
  prices?: { starter: string; pro: string; unlimited: string };
}

/**
 * The client-facing lane description. Production returns only the environment —
 * the app keeps its embedded live token/prices — so a production account's
 * response never contains a sandbox token or price id. A sandbox-lane account
 * gets the sandbox token and prices when the lane is complete; when it is not,
 * it gets `checkoutAvailable: false` (the server refuses that account's checkout
 * too), never a production answer the server would contradict.
 */
export function paddleClientConfig(env: Env, lane: PaddleLane): PaddleClientConfig {
  const root = rootPaddleEnv(env);
  if (lane !== "sandbox" || !sandboxLaneEnabled(root)) {
    return { environment: "production", checkoutAvailable: true };
  }
  if (!sandboxLaneComplete(root)) {
    return { environment: "sandbox", checkoutAvailable: false };
  }
  return {
    environment: "sandbox",
    checkoutAvailable: true,
    clientSideToken: nonEmpty(root.PADDLE_SANDBOX_CLIENT_TOKEN) ?? "",
    prices: {
      starter: nonEmpty(root.PADDLE_SANDBOX_STARTER_PRICE_ID) ?? "",
      pro: nonEmpty(root.PADDLE_SANDBOX_PRO_PRICE_ID) ?? "",
      unlimited: nonEmpty(root.PADDLE_SANDBOX_UNLIMITED_PRICE_ID) ?? "",
    },
  };
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
