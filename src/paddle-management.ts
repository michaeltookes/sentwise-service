import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { storedPaddleSubscriptionId } from "./paddle-account";
import { fetchPaddleManagementUrl } from "./paddle-api";
import { type Env } from "./config";
import { ApiError } from "./errors";

export async function handlePaddleManageBilling(userId: string, env: Env): Promise<Response> {
  const subscriptionId = await loadPaddleSubscriptionId(userId, env);
  if (!subscriptionId) {
    throw new ApiError(
      404,
      "billing_subscription_not_found",
      "No active Paddle subscription was found.",
    );
  }

  const url = await fetchPaddleManagementUrl(env, subscriptionId);
  if (!url) {
    throw new ApiError(
      502,
      "billing_portal_unavailable",
      "Could not open billing settings. Please try again.",
    );
  }

  return new Response(null, {
    status: 303,
    headers: { Location: url, "Cache-Control": "no-store" },
  });
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
