import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { PRICE_TO_PLAN, type Env } from "./config";
import { ApiError } from "./errors";
import {
  buildPaddleCheckoutCustomData,
  storedPaddleCustomerId,
  storedPaddleSubscriptionId,
} from "./paddle-account";
import { createPaddleCheckoutTransaction } from "./paddle-api";

const MAX_CHECKOUT_QUANTITY = 100;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function handlePaddleCheckout(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseCheckoutRequest(request, env);
  const account = await loadCheckoutAccount(userId, env);
  const customerId = storedPaddleCustomerId(account.subscription);

  if (body.kind === "subscription" && hasActivePaddleSubscription(account.subscription)) {
    throw new ApiError(
      409,
      "billing_subscription_active",
      "Manage your current subscription before starting a new one.",
    );
  }
  if (body.kind === "overage" && !hasActivePaddleSubscription(account.subscription)) {
    throw new ApiError(
      409,
      "billing_subscription_required",
      "An active Paddle subscription is required before buying extra drafts.",
    );
  }
  if (body.kind === "overage" && !customerId) {
    throw new ApiError(
      409,
      "billing_customer_not_bound",
      "Your Paddle customer is not ready for overage checkout yet.",
    );
  }

  const transaction = await createPaddleCheckoutTransaction(env, {
    priceId: body.priceId,
    quantity: body.quantity,
    customData: await buildPaddleCheckoutCustomData(userId, env),
    customerId,
  });

  const res = Response.json(transaction);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

interface CheckoutRequestBody {
  kind: "subscription" | "overage";
  priceId: string;
  quantity: number;
}

async function parseCheckoutRequest(request: Request, env: Env): Promise<CheckoutRequestBody> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
  }

  const body = asRecord(raw);
  const priceId = body?.priceId;
  if (typeof priceId !== "string" || priceId === "") {
    throw new ApiError(400, "invalid_request", "Missing Paddle price id.");
  }
  const kind = checkoutKindForPrice(priceId, env);
  if (!kind) {
    throw new ApiError(400, "invalid_request", "Unsupported Paddle price id.");
  }

  const quantity = positiveInt(body?.quantity) ?? 1;
  if (kind === "subscription" && quantity !== 1) {
    throw new ApiError(400, "invalid_request", "Subscription checkouts must use quantity 1.");
  }
  if (quantity > MAX_CHECKOUT_QUANTITY) {
    throw new ApiError(400, "invalid_request", "Checkout quantity is too large.");
  }

  return { kind, priceId, quantity };
}

async function loadCheckoutAccount(userId: string, env: Env): Promise<{ subscription: unknown }> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  try {
    const user = await clerk.users.getUser(userId);
    const meta = asRecord(user.privateMetadata) ?? {};
    return { subscription: meta.subscription };
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "Your account could not be found.");
    }
    throw new ApiError(
      502,
      "account_lookup_failed",
      "Could not load your account. Please try again.",
    );
  }
}

function checkoutKindForPrice(priceId: string, env: Env): CheckoutRequestBody["kind"] | null {
  if (PRICE_TO_PLAN[priceId] !== undefined) return "subscription";
  if (priceId === env.EXTRA_DRAFTS_PRICE_ID) return "overage";
  return null;
}

function hasActivePaddleSubscription(rawSubscription: unknown): boolean {
  const subscription = asRecord(rawSubscription);
  if (!subscription || !ACTIVE_SUBSCRIPTION_STATUSES.has(String(subscription.status))) {
    return false;
  }
  return isPaidPlan(subscription.plan) || storedPaddleSubscriptionId(rawSubscription) !== null;
}

function isPaidPlan(value: unknown): boolean {
  return value === "starter" || value === "pro" || value === "unlimited" || value === "team";
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
