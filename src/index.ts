import {
  authenticate,
  ClerkDeletionOutcomeUnknownError,
  deleteClerkUser,
  requireActiveTrial,
  resolveAccount,
} from "./auth";
import { forwardToAnthropic, parseDraftRequest } from "./anthropic";
import { ApiError, jsonError } from "./errors";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, type Env } from "./config";
import {
  buildQuota,
  conservativeRequestTokenBound,
  mondayStartUtc,
  resolveLimits,
  type WindowState,
} from "./metering";
import {
  quotaBeginAccountDeletion,
  quotaCancelAccountDeletion,
  quotaCheck,
  quotaDeferRelease,
  quotaDeferSettlement,
  quotaFinishAccountDeletion,
  quotaPeek,
  quotaRelease,
  quotaReserve,
  quotaSettle,
} from "./quota-client";
import { recordUsage } from "./analytics";
import { handleMargin } from "./admin";

// Re-export the Durable Object so the runtime can instantiate it (see wrangler.jsonc).
export { AccountQuota } from "./quota-do";

/**
 * Sentwise managed-inference Worker (backlog 56a + 56b).
 *
 * Routes:
 *   GET    /healthz       -> liveness, no auth
 *   GET    /v1/me         -> { userId, email, trial, subscription, quota } for account display
 *   DELETE /v1/me         -> delete the account (barrier, Clerk delete, quota tombstone) (73)
 *   POST   /v1/draft      -> forwards a drafting request to Anthropic (trial + metered)
 *   GET    /admin/margin  -> maintainer margin dashboard (ADMIN_TOKEN; 404 when unset)
 *
 * Content-stateless by design: no prompt/draft content is stored or logged. The
 * only state is counters, timestamps, and random reservation IDs — trial in Clerk,
 * usage in the AccountQuota Durable Object, aggregate hashed metrics in Analytics
 * Engine. See src/config.ts.
 */
export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }

      if (pathname === "/admin/margin" && request.method === "GET") {
        return await handleMargin(request, env);
      }

      if (pathname === "/v1/me" && request.method === "GET") {
        const { userId } = await authenticate(request, env);
        const account = await resolveAccount(userId, env, { initialize: false });
        const { window } = await quotaPeek(env, userId, { now: Date.now() });
        const limits = resolveLimits(env, account.quotaOverride, window.windowStart);
        // quotaOverride is internal — build the response explicitly, never spread it.
        return Response.json({
          userId: account.userId,
          email: account.email,
          trial: account.trial,
          subscription: account.subscription,
          quota: buildQuota(window, limits),
        });
      }

      if (pathname === "/v1/me" && request.method === "DELETE") {
        const { userId } = await authenticate(request, env);
        const deletionAttemptId = crypto.randomUUID();
        await quotaBeginAccountDeletion(env, userId, deletionAttemptId);
        try {
          await deleteClerkUser(userId, env);
        } catch (err) {
          if (err instanceof ClerkDeletionOutcomeUnknownError) throw err;
          await cancelAccountDeletionBarrier(env, userId, deletionAttemptId, ctx);
          throw err;
        }
        await finishAccountDeletion(env, userId, deletionAttemptId, ctx);
        return new Response(null, { status: 204 });
      }

      if (pathname === "/v1/draft" && request.method === "POST") {
        const { userId } = await authenticate(request, env);
        const account = await requireActiveTrial(userId, env);

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
        }
        const draft = parseDraftRequest(body);
        const model = draft.model ?? DEFAULT_MODEL;
        const now = Date.now();
        const limits = resolveLimits(env, account.quotaOverride, mondayStartUtc(now));

        // 1) Rate limit + read the current window (records this request's timestamp).
        const check = await quotaCheck(env, userId, {
          now,
          rateLimitPerMin: limits.rateLimitPerMin,
        });
        if (!check.allowed) {
          const res = jsonError(429, "rate_limited", "Too many requests. Slow down and retry.", {
            retryAfterSeconds: check.retryAfterSeconds,
          });
          res.headers.set("Retry-After", String(check.retryAfterSeconds));
          return res;
        }

        // 2) Per-request token safety cap (pre-flight conservative bound).
        const content = draftContentSize(draft.system, draft.messages);
        const maxTokens = draft.maxTokens ?? DEFAULT_MAX_TOKENS;
        const tokenBound = conservativeRequestTokenBound(
          content.bytes,
          maxTokens,
          content.framingItems,
        );
        if (tokenBound > limits.maxTokensPerRequest) {
          throw new ApiError(413, "request_too_large", "The request is too large to draft.");
        }

        // 3) Weekly quota admission + draft reservation. Hard mode blocks atomically;
        // soft mode reserves and continues so successful drafts are metered once.
        const reservationId = crypto.randomUUID();
        const reservation = await quotaReserve(env, userId, {
          now,
          reservationId,
          estimatedTokens: tokenBound,
          limits,
        });
        if (!reservation.reserved && reservation.blockedByQuota) {
          const resetsAt = buildQuota(reservation.window, limits).resetsAt;
          throw new ApiError(429, "quota_exceeded", "You've used your weekly allowance.", {
            resetsAt,
          });
        }
        if (!reservation.reserved) {
          throw new Error("quota_reservation_failed");
        }

        // 4) Forward to Anthropic, recording an aggregate metric either way.
        const t0 = Date.now();
        let result;
        try {
          result = await forwardToAnthropic(draft, env);
        } catch (err) {
          const outcome = err instanceof ApiError ? err.type : "internal_error";
          await releaseReservedUsage(
            env,
            userId,
            reservation.reservationId,
            reservation.window,
            reservation.estimatedTokens,
            ctx,
          );
          await recordUsage(env, {
            userId,
            model,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - t0,
            outcome,
          });
          throw err;
        }
        const latencyMs = Date.now() - t0;

        // 5) Record provider usage, then settle it into the reserved window.
        // Settlement may be delayed by account deletion, but the provider cost
        // already happened and should still feed aggregate margin metrics.
        const tokensDelta = result.usage.inputTokens + result.usage.outputTokens;
        await recordUsage(env, {
          userId,
          model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs,
          outcome: "ok",
        });
        const window = await settleReservedUsage(
          env,
          userId,
          reservation.reservationId,
          reservation.window,
          reservation.estimatedTokens,
          tokensDelta,
          ctx,
        );

        return Response.json({ ...result, quota: buildQuota(window, limits) });
      }

      // Known paths with the wrong method get 405; everything else 404.
      if (
        pathname === "/v1/draft" ||
        pathname === "/v1/me" ||
        pathname === "/healthz" ||
        (pathname === "/admin/margin" && !!env.ADMIN_TOKEN)
      ) {
        return jsonError(405, "method_not_allowed", "Method not allowed.");
      }
      return jsonError(404, "not_found", "Not found.");
    } catch (err) {
      if (err instanceof ApiError) {
        return err.toResponse();
      }
      // Last-resort catch — never leak stack traces or content.
      return jsonError(500, "internal_error", "Something went wrong. Please try again.");
    }
  },
} satisfies ExportedHandler<Env>;

function draftContentSize(
  system: string | undefined,
  messages: Array<{ content: string }>,
): { bytes: number; framingItems: number } {
  const enc = new TextEncoder();
  let bytes = system ? enc.encode(system).byteLength : 0;
  for (const message of messages) {
    bytes += enc.encode(message.content).byteLength;
  }
  return { bytes, framingItems: messages.length + (system === undefined ? 0 : 1) };
}

async function settleReservedUsage(
  env: Env,
  userId: string,
  reservationId: string,
  reservedWindow: WindowState,
  estimatedTokens: number,
  tokensDelta: number,
  ctx?: ExecutionContext,
): Promise<WindowState> {
  const body = {
    now: Date.now(),
    reservationId,
    reservationWindowStart: reservedWindow.windowStart,
    estimatedTokens,
    tokensDelta,
  };
  try {
    return (await quotaSettle(env, userId, body)).window;
  } catch (err) {
    if (isAccountDeletionInProgressError(err)) {
      await deferSettlementBlockedByDeletion(env, userId, body, ctx);
      throw err;
    }
    if (isAccountDeletionError(err)) throw err;
    try {
      return (await quotaSettle(env, userId, { ...body, now: Date.now() })).window;
    } catch (retryErr) {
      if (isAccountDeletionInProgressError(retryErr)) {
        await deferSettlementBlockedByDeletion(env, userId, body, ctx);
        throw retryErr;
      }
      if (isAccountDeletionError(retryErr)) throw retryErr;
      try {
        await quotaDeferSettlement(env, userId, { ...body, now: Date.now() });
      } catch (deferErr) {
        if (isAccountDeletionError(deferErr)) throw deferErr;
        ctx?.waitUntil(
          quotaDeferSettlement(env, userId, { ...body, now: Date.now() }).catch(() => undefined),
        );
      }
      return optimisticSettledWindow(reservedWindow, reservationId, estimatedTokens, tokensDelta);
    }
  }
}

async function deferSettlementBlockedByDeletion(
  env: Env,
  userId: string,
  body: {
    reservationId: string;
    reservationWindowStart: number;
    estimatedTokens: number;
    tokensDelta: number;
  },
  ctx?: ExecutionContext,
): Promise<void> {
  const defer = () => quotaDeferSettlement(env, userId, { ...body, now: Date.now() });
  try {
    await defer();
  } catch (err) {
    if (isAccountDeletionError(err)) return;
    ctx?.waitUntil(defer().catch(() => undefined));
  }
}

function optimisticSettledWindow(
  reservedWindow: WindowState,
  reservationId: string,
  estimatedTokens: number,
  tokensDelta: number,
): WindowState {
  return {
    ...reservedWindow,
    tokensUsed: reservedWindow.tokensUsed + tokensDelta,
    tokensReserved: Math.max(0, (reservedWindow.tokensReserved ?? 0) - estimatedTokens),
    activeReservations: reservedWindow.activeReservations?.filter((r) => r.id !== reservationId),
  };
}

async function releaseReservedUsage(
  env: Env,
  userId: string,
  reservationId: string,
  reservedWindow: WindowState,
  estimatedTokens: number,
  ctx?: ExecutionContext,
): Promise<void> {
  const body = {
    now: Date.now(),
    reservationId,
    reservationWindowStart: reservedWindow.windowStart,
    estimatedTokens,
  };
  try {
    await quotaRelease(env, userId, body);
  } catch (err) {
    if (isAccountDeletionInProgressError(err)) {
      await deferReleaseBlockedByDeletion(env, userId, body, ctx);
      return;
    }
    if (isAccountDeletionError(err)) return;
    try {
      await quotaRelease(env, userId, { ...body, now: Date.now() });
    } catch (retryErr) {
      if (isAccountDeletionInProgressError(retryErr)) {
        await deferReleaseBlockedByDeletion(env, userId, body, ctx);
        return;
      }
      if (isAccountDeletionError(retryErr)) return;
      // The reservation also has a DO-side TTL, so a repeated release outage
      // cannot hold quota capacity until the weekly reset.
    }
  }
}

async function deferReleaseBlockedByDeletion(
  env: Env,
  userId: string,
  body: {
    reservationId: string;
    reservationWindowStart: number;
    estimatedTokens: number;
  },
  ctx?: ExecutionContext,
): Promise<void> {
  const defer = () => quotaDeferRelease(env, userId, { ...body, now: Date.now() });
  try {
    await defer();
  } catch (err) {
    if (isAccountDeletionError(err)) return;
    ctx?.waitUntil(defer().catch(() => undefined));
  }
}

async function cancelAccountDeletionBarrier(
  env: Env,
  userId: string,
  attemptId: string,
  ctx?: ExecutionContext,
): Promise<void> {
  const cancel = async () => {
    const result = await quotaCancelAccountDeletion(env, userId, attemptId);
    if (!result.cancelled && result.barrierActive) {
      throw new Error("account deletion barrier is still active");
    }
    return result;
  };
  try {
    await retryQuotaSideEffect(cancel);
  } catch {
    ctx?.waitUntil(retryQuotaSideEffect(cancel).catch(() => undefined));
    throw new ApiError(
      503,
      "account_deletion_recovery_failed",
      "Could not restore account deletion state. Please try again.",
    );
  }
}

async function finishAccountDeletion(
  env: Env,
  userId: string,
  attemptId: string,
  ctx?: ExecutionContext,
): Promise<void> {
  try {
    await retryQuotaSideEffect(() => quotaFinishAccountDeletion(env, userId, attemptId));
  } catch {
    ctx?.waitUntil(
      retryQuotaSideEffect(() => quotaFinishAccountDeletion(env, userId, attemptId)).catch(
        () => undefined,
      ),
    );
  }
}

async function retryQuotaSideEffect<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

function isAccountDeletionError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    (err.type === "account_deleted" || err.type === "account_deletion_in_progress")
  );
}

function isAccountDeletionInProgressError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.type === "account_deletion_in_progress";
}
