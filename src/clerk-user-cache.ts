// S-M1 (security pass 2026-09-13): a short-TTL, in-memory, per-user cache in
// front of Clerk `users.getUser`. Workers isolates are ephemeral, so a plain Map
// with per-entry expiry is the right shape — it blunts a scripted account
// hammering an unauthenticated-cost route (e.g. GET /v1/me) into exhausting
// Clerk's per-instance Backend API rate limits (which would surface as
// account_lookup_failed for every user — a whole-service DoS).
//
// Scope (deliberately narrow): only the pure-READ, hammer-able request paths use
// the cache — GET /v1/me and GET /v1/paddle/manage-billing (`useCache: true`).
// POST /v1/draft is protected by the rate-limit reorder instead and reads fresh;
// DELETE /v1/me and every read-modify-write entitlement path read fresh so a
// concurrent write is never lost.
//
// Safety of the TTL: entitlement is never *granted* from a stale entry — actual
// drafting access is re-checked fresh on /v1/draft (requireActiveTrial, uncached),
// so a stale /v1/me can only mis-*display* state for at most the TTL, never let an
// expired account draft. Same-isolate mutations invalidate explicitly (trial init
// and account deletion, below); cross-isolate writes (Durable Object entitlement
// handlers) are reconciled within the TTL. Keep the TTL well under a minute.
//
// PRIVACY: caches only the Clerk user record already loaded for the request
// (counters/ids/metadata). No prompt or draft content passes through here.

import { createClerkClient } from "@clerk/backend";
import type { Env } from "./config";

export const CLERK_USER_CACHE_TTL_MS = 30_000;

type ClerkUsers = ReturnType<typeof createClerkClient>["users"];
type ClerkUser = Awaited<ReturnType<ClerkUsers["getUser"]>>;

interface CacheEntry {
  expiresAt: number;
  user: ClerkUser;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetch the Clerk user, optionally served from / stored in the short-TTL cache.
 * Errors (including Clerk 404s) propagate unchanged so callers keep their exact
 * not-found / lookup-failed mapping. Only successful lookups are cached, and only
 * when `useCache` is set.
 */
export async function getCachedClerkUser(
  env: Env,
  userId: string,
  options?: { useCache?: boolean },
): Promise<ClerkUser> {
  const useCache = options?.useCache === true;
  const now = Date.now();

  if (useCache) {
    const hit = cache.get(userId);
    if (hit && hit.expiresAt > now) return hit.user;
    if (hit) cache.delete(userId); // expired
  }

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const user = await clerk.users.getUser(userId);

  if (useCache) {
    cache.set(userId, { user, expiresAt: now + CLERK_USER_CACHE_TTL_MS });
  }
  return user;
}

/**
 * Drop a user's cached record. Call after any same-isolate mutation of the user's
 * Clerk metadata (trial init, account deletion) so a cached read can't serve
 * stale trial/subscription state.
 */
export function invalidateClerkUser(userId: string): void {
  cache.delete(userId);
}

/** Test-only: clear all cached entries between tests. */
export function __resetClerkUserCache(): void {
  cache.clear();
}
