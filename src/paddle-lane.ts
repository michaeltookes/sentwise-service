// 123 — resolve the Paddle lane for an authenticated account. Kept apart from
// src/paddle-env.ts (pure, no I/O) because it needs a Clerk lookup.
//
// Two questions, answered differently:
//   - NEW activity (checkout): the account's CURRENT lane — PADDLE_ENV=sandbox
//     plus a @prowlqa.dev email — and the sandbox lane must be fully configured.
//   - EXISTING objects (manage billing, plan change): the lane the stored
//     subscription was CREATED in, so a sandbox subscription is never sent to
//     the live API after the lane closes (or the email changes), and vice versa.

import { isClerkNotFoundError, primaryEmail } from "./auth";
import { getCachedClerkUser } from "./clerk-user-cache";
import type { Env } from "./config";
import { ApiError } from "./errors";
import {
  paddleEnvForLane,
  paddleEnvForStoredLane,
  paddleLaneForEmail,
  sandboxInPlay,
  sandboxLaneComplete,
  storedPaddleLane,
  type PaddleLane,
} from "./paddle-env";

interface LaneUser {
  email: string | null;
  storedSubscription: unknown;
}

// Every caller here decides where a STATE-CHANGING Paddle call goes (checkout,
// plan change, portal session), so the lane is always read from a fresh Clerk
// record, never the 30s display cache: a stale email must not send a QA buyer
// to a live, chargeable checkout (or a customer to the sandbox).
async function loadLaneUser(userId: string, env: Env): Promise<LaneUser | null> {
  // Production-only deployments (the default) never pay for a lookup.
  if (!sandboxInPlay(env)) return { email: null, storedSubscription: null };
  let user;
  try {
    user = await getCachedClerkUser(env, userId, { useCache: false });
  } catch (err) {
    if (isClerkNotFoundError(err)) return null;
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }
  const meta = (user.privateMetadata ?? {}) as Record<string, unknown>;
  return { email: primaryEmail(user), storedSubscription: meta.subscription };
}

function sandboxUnavailableError(): ApiError {
  return new ApiError(
    503,
    "sandbox_checkout_unavailable",
    "Test checkout is not configured for this account.",
  );
}

/** The account's current lane (production for a missing account). */
export async function paddleLaneForUser(userId: string, env: Env): Promise<PaddleLane> {
  const user = await loadLaneUser(userId, env);
  return paddleLaneForEmail(env, user?.email ?? null);
}

/**
 * Env for starting a NEW checkout. A QA account in an incompletely configured
 * sandbox lane is refused (503) — it is never quietly sent to production, and
 * /v1/me reports `checkoutAvailable: false` for the same account.
 */
export async function paddleEnvForCheckout(userId: string, env: Env): Promise<Env> {
  const lane = await paddleLaneForUser(userId, env);
  if (lane === "sandbox" && !sandboxLaneComplete(env)) throw sandboxUnavailableError();
  return paddleEnvForLane(env, lane);
}

/**
 * Env for changing the plan of the EXISTING subscription. Routed by the stored
 * lane, and only allowed while that lane is still the account's current lane: a
 * stranded sandbox subscription (lane closed or email changed) is not a paid
 * plan any more, so it can't be re-tiered — only managed (cancelled).
 */
export async function paddleEnvForPlanChange(userId: string, env: Env): Promise<Env> {
  const user = await loadLaneUser(userId, env);
  const stored = storedPaddleLane(user?.storedSubscription);
  const current = paddleLaneForEmail(env, user?.email ?? null);
  if (stored !== current) {
    throw new ApiError(
      409,
      "billing_environment_mismatch",
      "This subscription can't be changed here. Manage it from billing.",
    );
  }
  if (current === "sandbox" && !sandboxLaneComplete(env)) throw sandboxUnavailableError();
  return paddleEnvForStoredLane(env, stored);
}
