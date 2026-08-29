import { authenticate, requireActiveTrial, resolveAccount } from "./auth";
import { forwardToAnthropic, parseDraftRequest } from "./anthropic";
import { ApiError, jsonError } from "./errors";
import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, type Env } from "./config";
import {
  buildQuota,
  estimateRequestTokens,
  mondayStartUtc,
  resolveLimits,
  type WindowState,
} from "./metering";
import { quotaCheck, quotaPeek, quotaRelease, quotaReserve, quotaSettle } from "./quota-client";
import { recordUsage } from "./analytics";
import { handleMargin } from "./admin";

// Re-export the Durable Object so the runtime can instantiate it (see wrangler.jsonc).
export { AccountQuota } from "./quota-do";

/**
 * Sentwise managed-inference Worker (backlog 56a + 56b).
 *
 * Routes:
 *   GET  /healthz       -> liveness, no auth
 *   GET  /v1/me         -> { userId, email, trial, quota } for the account display
 *   POST /v1/draft      -> forwards a drafting request to Anthropic (trial + metered)
 *   GET  /admin/margin  -> maintainer margin dashboard (ADMIN_TOKEN; 404 when unset)
 *
 * Content-stateless by design: no prompt/draft content is stored or logged. The
 * only state is counters + timestamps — trial in Clerk, usage in the AccountQuota
 * Durable Object, aggregate hashed metrics in Analytics Engine. See src/config.ts.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
          quota: buildQuota(window, limits),
        });
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

        // 2) Per-request token safety cap (pre-flight estimate).
        const contentChars =
          (draft.system?.length ?? 0) +
          draft.messages.reduce((sum, m) => sum + m.content.length, 0);
        const estTokens = estimateRequestTokens(
          contentChars,
          draft.maxTokens ?? DEFAULT_MAX_TOKENS,
        );
        if (estTokens > limits.maxTokensPerRequest) {
          throw new ApiError(413, "request_too_large", "The request is too large to draft.");
        }

        // 3) Weekly quota admission + draft reservation. Hard mode blocks atomically;
        // soft mode reserves and continues so successful drafts are metered once.
        const reservation = await quotaReserve(env, userId, { now, limits });
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
          await quotaRelease(env, userId, {
            now: Date.now(),
            reservationWindowStart: reservation.window.windowStart,
          }).catch(() => undefined);
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

        // 5) Settle real usage into the reserved window, then report the updated quota.
        const tokensDelta = result.usage.inputTokens + result.usage.outputTokens;
        const window = await settleReservedUsage(env, userId, reservation.window, tokensDelta);
        await recordUsage(env, {
          userId,
          model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs,
          outcome: "ok",
        });

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

async function settleReservedUsage(
  env: Env,
  userId: string,
  reservedWindow: WindowState,
  tokensDelta: number,
): Promise<WindowState> {
  const body = {
    now: Date.now(),
    reservationWindowStart: reservedWindow.windowStart,
    tokensDelta,
  };
  try {
    return (await quotaSettle(env, userId, body)).window;
  } catch {
    try {
      return (await quotaSettle(env, userId, { ...body, now: Date.now() })).window;
    } catch {
      return { ...reservedWindow, tokensUsed: reservedWindow.tokensUsed + tokensDelta };
    }
  }
}
