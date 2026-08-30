// Thin client the request handler uses to talk to the AccountQuota Durable
// Object (56b). Keeps the DO-plumbing out of src/index.ts.

import type { Env } from "./config";
import type { ResolvedLimits, WindowState } from "./metering";

export interface CheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  window: WindowState;
}
export interface WindowResult {
  window: WindowState;
}
export interface ReserveResult {
  reserved: boolean;
  blockedByQuota: boolean;
  reservationId: string;
  estimatedTokens: number;
  window: WindowState;
}
export interface SettleBody {
  now: number;
  reservationId?: string;
  reservationWindowStart?: number;
  estimatedTokens?: number;
  draftsDelta?: number;
  tokensDelta: number;
}

async function call<T>(env: Env, userId: string, op: string, body: unknown): Promise<T> {
  const id = env.ACCOUNT_QUOTA.idFromName(userId);
  const stub = env.ACCOUNT_QUOTA.get(id);
  const res = await stub.fetch(`https://account-quota.internal${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json<T>();
}

/** Rate-limit check + current window snapshot (records the request timestamp). */
export function quotaCheck(
  env: Env,
  userId: string,
  body: { now: number; rateLimitPerMin: number },
): Promise<CheckResult> {
  return call<CheckResult>(env, userId, "/check", body);
}

/** Atomically admit a draft against the weekly quota and reserve one draft slot. */
export function quotaReserve(
  env: Env,
  userId: string,
  body: { now: number; reservationId: string; estimatedTokens: number; limits: ResolvedLimits },
): Promise<ReserveResult> {
  return call<ReserveResult>(env, userId, "/reserve", body);
}

/** Settle token usage after a successful reserved draft; returns the updated window. */
export function quotaSettle(env: Env, userId: string, body: SettleBody): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/settle", body);
}

/** Persist a settlement for Durable Object alarm replay after immediate retries fail. */
export function quotaDeferSettlement(
  env: Env,
  userId: string,
  body: SettleBody,
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/defer-settlement", body);
}

/** Roll back a reserved draft slot after an upstream failure. */
export function quotaRelease(
  env: Env,
  userId: string,
  body: {
    now: number;
    reservationId?: string;
    reservationWindowStart: number;
    estimatedTokens: number;
  },
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/release", body);
}

/** Read (and roll) the window without rate-limiting or incrementing — for /v1/me. */
export function quotaPeek(env: Env, userId: string, body: { now: number }): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/peek", body);
}

/**
 * Wipe all persisted state for the account (73, account deletion): usage
 * counters, in-flight reservations, settlement markers, and the settlement
 * alarm. Called by DELETE /v1/me before the Clerk user is deleted.
 */
export function quotaWipe(env: Env, userId: string): Promise<{ wiped: boolean }> {
  return call<{ wiped: boolean }>(env, userId, "/wipe", {});
}
