// Thin client the request handler uses to talk to the AccountQuota Durable
// Object (56b). Keeps the DO-plumbing out of src/index.ts.

import type { Env } from "./config";
import type { WindowState } from "./metering";

export interface CheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
  window: WindowState;
}
export interface WindowResult {
  window: WindowState;
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

/** Increment usage after a successful draft; returns the updated window. */
export function quotaSettle(
  env: Env,
  userId: string,
  body: { now: number; draftsDelta: number; tokensDelta: number },
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/settle", body);
}

/** Read (and roll) the window without rate-limiting or incrementing — for /v1/me. */
export function quotaPeek(env: Env, userId: string, body: { now: number }): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/peek", body);
}
