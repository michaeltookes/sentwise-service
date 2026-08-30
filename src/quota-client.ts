// Thin client the request handler uses to talk to the AccountQuota Durable
// Object (56b). Keeps the DO-plumbing out of src/index.ts.

import type { Env } from "./config";
import { ApiError, type ErrorExtra } from "./errors";
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
export interface BeginAccountDeletionResult {
  deleting: boolean;
  alreadyDeleted: boolean;
  attemptId: string;
  expiresAt?: number;
}
export interface CancelAccountDeletionResult {
  cancelled: boolean;
  barrierActive?: boolean;
}
export interface FinishAccountDeletionResult {
  deleted: boolean;
  cleanupPending?: boolean;
}

async function call<T>(env: Env, userId: string, op: string, body: unknown): Promise<T> {
  const id = env.ACCOUNT_QUOTA.idFromName(userId);
  const stub = env.ACCOUNT_QUOTA.get(id);
  const res = await stub.fetch(`https://account-quota.internal${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw await quotaError(res, op);
  }
  return res.json<T>();
}

async function quotaError(res: Response, op: string): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new Error(`quota_${op.slice(1)}_failed`);
  }

  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const fields = error as Record<string, unknown>;
      if (typeof fields.type === "string" && typeof fields.message === "string") {
        const extra: ErrorExtra = {};
        for (const [key, value] of Object.entries(fields)) {
          if (key !== "type" && key !== "message") {
            extra[key] = value;
          }
        }
        return new ApiError(res.status, fields.type, fields.message, extra);
      }
    }
  }

  return new Error(`quota_${op.slice(1)}_failed`);
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

/** Persist a reservation release for alarm replay after deletion temporarily blocks it. */
export function quotaDeferRelease(
  env: Env,
  userId: string,
  body: {
    now: number;
    reservationId: string;
    reservationWindowStart: number;
    estimatedTokens: number;
  },
): Promise<WindowResult> {
  return call<WindowResult>(env, userId, "/defer-release", body);
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

/** Set a deletion barrier before attempting Clerk deletion. Does not wipe counters. */
export function quotaBeginAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
): Promise<BeginAccountDeletionResult> {
  return call<BeginAccountDeletionResult>(env, userId, "/begin-delete", {
    now: Date.now(),
    attemptId,
  });
}

/** Remove an in-progress deletion barrier when Clerk deletion fails. */
export function quotaCancelAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
): Promise<CancelAccountDeletionResult> {
  return call<CancelAccountDeletionResult>(env, userId, "/cancel-delete", {
    now: Date.now(),
    attemptId,
  });
}

/** Wipe account quota data after Clerk deletion succeeds and keep a stale-token tombstone. */
export function quotaFinishAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
): Promise<FinishAccountDeletionResult> {
  return call<FinishAccountDeletionResult>(env, userId, "/finish-delete", {
    now: Date.now(),
    attemptId,
  });
}

/**
 * Compatibility alias for final account deletion. New callers should use the
 * begin/delete/cancel-or-finish flow above so Clerk failures do not wipe quotas.
 */
export function quotaWipe(env: Env, userId: string): Promise<{ wiped: boolean; deleted: boolean }> {
  return call<{ wiped: boolean; deleted: boolean }>(env, userId, "/wipe", {});
}
