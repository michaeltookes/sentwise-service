// 123 — resolve the Paddle lane for an authenticated account. Kept apart from
// src/paddle-env.ts (pure, no I/O) because it needs a Clerk lookup.

import { isClerkNotFoundError, primaryEmail } from "./auth";
import { getCachedClerkUser } from "./clerk-user-cache";
import type { Env } from "./config";
import { ApiError } from "./errors";
import {
  paddleEnvForLane,
  paddleLaneForEmail,
  sandboxLaneEnabled,
  type PaddleLane,
} from "./paddle-env";

/**
 * The lane for `userId`. Costs nothing when the sandbox lane is off (the
 * production default): no Clerk call is made. When it is on, the account's
 * primary email decides; a missing account resolves to production.
 */
export async function paddleLaneForUser(userId: string, env: Env): Promise<PaddleLane> {
  if (!sandboxLaneEnabled(env)) return "production";
  let user;
  try {
    user = await getCachedClerkUser(env, userId, { useCache: true });
  } catch (err) {
    if (isClerkNotFoundError(err)) return "production";
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }
  return paddleLaneForEmail(env, primaryEmail(user));
}

export async function paddleEnvForUser(userId: string, env: Env): Promise<Env> {
  return paddleEnvForLane(env, await paddleLaneForUser(userId, env));
}
