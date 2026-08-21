import { authenticate, requireActiveTrial, resolveAccount } from "./auth";
import { forwardToAnthropic, parseDraftRequest } from "./anthropic";
import { ApiError, jsonError } from "./errors";
import type { Env } from "./config";
import { isCallbackPath, renderCallbackPage } from "./callback";

/**
 * Sentwise managed-inference Worker (backlog 56a).
 *
 * Routes:
 *   GET  /healthz    -> liveness, no auth
 *   GET  /auth/callback, /openrouter/callback -> browser landing pages that hand
 *        the OAuth / key-provisioning result to the Mac app's sentwise:// scheme
 *   GET  /v1/me      -> { userId, email, trial } for the account display
 *   POST /v1/draft   -> forwards a drafting request to Anthropic (trial-gated)
 *
 * Stateless by design: no storage, no content logging. The only persisted
 * state is `trialStartedAt` in the user's Clerk privateMetadata.
 *
 * TODO(56b): per-account token metering, daily/monthly caps, rate limiting,
 * and abuse controls are intentionally out of scope for 56a.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }

      // Browser landing pages for the Google / OpenRouter round-trips (item 59).
      if (isCallbackPath(pathname) && request.method === "GET") {
        return renderCallbackPage(pathname, url.searchParams);
      }

      if (pathname === "/v1/me" && request.method === "GET") {
        const { userId } = await authenticate(request, env);
        const account = await resolveAccount(userId, env, { initialize: false });
        return Response.json(account);
      }

      if (pathname === "/v1/draft" && request.method === "POST") {
        const { userId } = await authenticate(request, env);
        await requireActiveTrial(userId, env);

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
        }
        const draft = parseDraftRequest(body);
        const result = await forwardToAnthropic(draft, env);
        return Response.json(result);
      }

      // Known paths with the wrong method get 405; everything else 404.
      if (
        pathname === "/v1/draft" ||
        pathname === "/v1/me" ||
        pathname === "/healthz" ||
        isCallbackPath(pathname)
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
