import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { storedPaddleSubscriptionId } from "./paddle-account";
import { fetchPaddleManagementUrl, type PaddleManagementAction } from "./paddle-api";
import { type Env } from "./config";
import { ApiError } from "./errors";

export async function handlePaddleManageBilling(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const action = parseManagementAction(request);
  const subscriptionId = await loadPaddleSubscriptionId(userId, env);
  if (!subscriptionId) {
    throw new ApiError(
      404,
      "billing_subscription_not_found",
      "No active Paddle subscription was found.",
    );
  }

  const url = await fetchPaddleManagementUrl(env, subscriptionId, action);
  if (!url) {
    throw new ApiError(
      502,
      "billing_portal_unavailable",
      "Could not open billing settings. Please try again.",
    );
  }

  const res = Response.json({ managementUrl: url });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function parseManagementAction(request: Request): PaddleManagementAction {
  const action = new URL(request.url).searchParams.get("action") ?? "update_payment_method";
  if (action === "update_payment_method" || action === "cancel") return action;
  throw new ApiError(400, "invalid_request", "Unsupported billing management action.");
}

async function loadPaddleSubscriptionId(userId: string, env: Env): Promise<string | null> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    const user = await clerk.users.getUser(userId);
    const meta = user.privateMetadata ?? {};
    return storedPaddleSubscriptionId(meta.subscription);
  } catch (err) {
    if (isClerkNotFoundError(err)) return null;
    throw new ApiError(502, "account_lookup_failed", "Could not load your account.");
  }
}
