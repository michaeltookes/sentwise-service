import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { storedPaddleCustomerId, storedPaddleSubscriptionId } from "./paddle-account";
import {
  createPaddlePortalSession,
  fetchPaddleManagementUrl,
  fetchPaddleSubscriptionSnapshot,
  type PaddleManagementAction,
} from "./paddle-api";
import { type Env } from "./config";
import { ApiError } from "./errors";

interface PaddleBillingAccount {
  subscriptionId: string;
  customerId: string | null;
}

export async function handlePaddleManageBilling(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const action = parseManagementAction(request);
  const account = await loadPaddleBillingAccount(userId, env);
  if (!account) {
    throw new ApiError(
      404,
      "billing_subscription_not_found",
      "No active Paddle subscription was found.",
    );
  }

  const url = await resolveManagementUrl(env, account, action);
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

/**
 * Prefer an authenticated customer-portal-session deep link (item 91) — it skips
 * the portal's email sign-in step — and fall back to the pre-generated
 * `management_urls` path if the session create fails for any reason, so billing
 * management never regresses to a dead button.
 */
async function resolveManagementUrl(
  env: Env,
  account: PaddleBillingAccount,
  action: PaddleManagementAction,
): Promise<string | null> {
  const sessionUrl = await mintPortalSessionUrl(env, account, action);
  if (sessionUrl) return sessionUrl;
  return fetchPaddleManagementUrl(env, account.subscriptionId, action);
}

async function mintPortalSessionUrl(
  env: Env,
  account: PaddleBillingAccount,
  action: PaddleManagementAction,
): Promise<string | null> {
  const customerId =
    account.customerId ?? (await recoverPaddleCustomerId(env, account.subscriptionId));
  if (!customerId) return null;
  return createPaddlePortalSession(env, customerId, account.subscriptionId, action);
}

/**
 * The webhook stores the Paddle customer id in `privateMetadata.subscription`,
 * but recover it from the live subscription entity when it's absent so the
 * portal-session path still works for older accounts. Never throws — any failure
 * leaves us on the `management_urls` fallback.
 */
async function recoverPaddleCustomerId(env: Env, subscriptionId: string): Promise<string | null> {
  try {
    const snapshot = await fetchPaddleSubscriptionSnapshot(env, subscriptionId);
    return snapshot?.customerId ?? null;
  } catch {
    return null;
  }
}

function parseManagementAction(request: Request): PaddleManagementAction {
  const action = new URL(request.url).searchParams.get("action") ?? "update_payment_method";
  if (action === "update_payment_method" || action === "cancel") return action;
  throw new ApiError(400, "invalid_request", "Unsupported billing management action.");
}

async function loadPaddleBillingAccount(
  userId: string,
  env: Env,
): Promise<PaddleBillingAccount | null> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    const user = await clerk.users.getUser(userId);
    const meta = user.privateMetadata ?? {};
    const subscriptionId = storedPaddleSubscriptionId(meta.subscription);
    if (!subscriptionId) return null;
    return { subscriptionId, customerId: storedPaddleCustomerId(meta.subscription) };
  } catch (err) {
    if (isClerkNotFoundError(err)) return null;
    throw new ApiError(502, "account_lookup_failed", "Could not load your account.");
  }
}
