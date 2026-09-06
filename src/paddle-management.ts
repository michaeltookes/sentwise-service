import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { PADDLE_SANDBOX_API_BASE, type Env } from "./config";
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

export async function fetchPaddleManagementUrl(
  env: Env,
  subscriptionId: string,
): Promise<string | null> {
  if (!env.PADDLE_API_KEY) return null;
  try {
    const res = await fetch(
      `${paddleApiBase(env)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        headers: {
          Authorization: `Bearer ${env.PADDLE_API_KEY}`,
          "content-type": "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const data = asRecord(asRecord(body)?.data);
    const urls = asRecord(data?.management_urls);
    const candidate = urls?.update_payment_method ?? urls?.cancel;
    return validHttpsUrl(candidate);
  } catch {
    return null;
  }
}

async function loadPaddleSubscriptionId(userId: string, env: Env): Promise<string | null> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    const user = await clerk.users.getUser(userId);
    const meta = user.privateMetadata ?? {};
    const subscription = asRecord(meta.subscription);
    const id = subscription?.paddleSubscriptionId;
    return typeof id === "string" && id !== "" ? id : null;
  } catch (err) {
    if (isClerkNotFoundError(err)) return null;
    throw new ApiError(502, "account_lookup_failed", "Could not load your account.");
  }
}

function paddleApiBase(env: Env): string {
  return env.PADDLE_API_BASE && env.PADDLE_API_BASE !== ""
    ? env.PADDLE_API_BASE
    : PADDLE_SANDBOX_API_BASE;
}

function validHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
