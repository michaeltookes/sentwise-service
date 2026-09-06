import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { PRICE_TO_PLAN, type Env } from "./config";
import { ApiError } from "./errors";
import {
  buildPaddleCheckoutCustomData,
  storedPaddleCustomerId,
  storedPaddleSubscriptionId,
} from "./paddle-account";
import { createPaddleCheckoutTransaction, fetchPaddleTransactionSnapshot } from "./paddle-api";
import {
  quotaRecordPaddleSubscriptionCheckout,
  quotaReleasePaddleSubscriptionCheckout,
  quotaReservePaddleSubscriptionCheckout,
} from "./quota-client";

const MAX_CHECKOUT_QUANTITY = 100;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function handlePaddleCheckout(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseCheckoutRequest(request, env);
  if (!env.PADDLE_WEBHOOK_SECRET) {
    throw new ApiError(503, "checkout_unavailable", "Checkout is not configured.");
  }
  let account = await loadCheckoutAccount(userId, env);
  let customerId = storedPaddleCustomerId(account.subscription);

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

  const checkoutReservationId = body.kind === "subscription" ? crypto.randomUUID() : null;
  if (checkoutReservationId) {
    const existingTransaction = await reserveSubscriptionCheckout(
      env,
      userId,
      checkoutReservationId,
      body,
    );
    if (existingTransaction) return checkoutResponse(existingTransaction);

    try {
      account = await loadCheckoutAccount(userId, env);
    } catch (err) {
      await quotaReleasePaddleSubscriptionCheckout(env, userId, checkoutReservationId).catch(
        () => undefined,
      );
      throw err;
    }
    if (hasActivePaddleSubscription(account.subscription)) {
      await quotaReleasePaddleSubscriptionCheckout(env, userId, checkoutReservationId).catch(
        () => undefined,
      );
      throw new ApiError(
        409,
        "billing_subscription_active",
        "Manage your current subscription before starting a new one.",
      );
    }
    customerId = storedPaddleCustomerId(account.subscription);
  }

  let transaction;
  try {
    transaction = await createPaddleCheckoutTransaction(env, {
      priceId: body.priceId,
      quantity: body.quantity,
      customData: await buildPaddleCheckoutCustomData(
        userId,
        env,
        checkoutReservationId ?? undefined,
      ),
      customerId,
    });
  } catch (err) {
    if (checkoutReservationId) {
      await quotaReleasePaddleSubscriptionCheckout(env, userId, checkoutReservationId).catch(
        () => undefined,
      );
    }
    throw err;
  }

  if (checkoutReservationId) {
    const recordResult = await quotaRecordPaddleSubscriptionCheckout(env, userId, {
      reservationId: checkoutReservationId,
      transactionId: transaction.transactionId,
      checkoutUrl: transaction.checkoutUrl,
      priceId: body.priceId,
      quantity: body.quantity,
    });
    if ("stale" in recordResult) {
      throw pendingCheckoutError();
    }
  }

  return checkoutResponse(transaction);
}

async function reserveSubscriptionCheckout(
  env: Env,
  userId: string,
  reservationId: string,
  request: CheckoutRequestBody,
): Promise<{ transactionId: string; checkoutUrl: string | null } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const reservation = await quotaReservePaddleSubscriptionCheckout(env, userId, {
      now: Date.now(),
      reservationId,
      priceId: request.priceId,
      quantity: request.quantity,
    });
    if ("reserved" in reservation) return null;

    const pending = await recoverOrReleasePendingCheckout(env, userId, reservation, request);
    if (pending) return pending;
  }
  throw pendingCheckoutError();
}

async function recoverOrReleasePendingCheckout(
  env: Env,
  userId: string,
  reservation: {
    reservationId?: string;
    transactionId?: string;
    checkoutUrl?: string | null;
    priceId?: string;
    quantity?: number;
  },
  request: CheckoutRequestBody,
): Promise<{ transactionId: string; checkoutUrl: string | null } | null> {
  if (!reservation.reservationId || !reservation.transactionId) {
    throw pendingCheckoutError();
  }

  const snapshot = await pendingCheckoutTransactionSnapshot(env, reservation.transactionId);
  if (!snapshot || snapshot.status === "canceled") {
    await quotaReleasePaddleSubscriptionCheckout(env, userId, reservation.reservationId);
    return null;
  }
  const checkoutUrl = snapshot.checkoutUrl ?? reservation.checkoutUrl ?? null;
  if (isRecoverableCheckoutTransaction(snapshot.status, checkoutUrl)) {
    if (!checkoutMatchesRequest(reservation, snapshot, request)) {
      throw checkoutConflictError();
    }
    return {
      transactionId: reservation.transactionId,
      checkoutUrl,
    };
  }
  throw pendingCheckoutError();
}

async function pendingCheckoutTransactionSnapshot(
  env: Env,
  transactionId: string,
): Promise<{
  status: string | null;
  checkoutUrl: string | null;
  items: { priceId: string; quantity: number }[];
} | null> {
  try {
    return await fetchPaddleTransactionSnapshot(env, transactionId);
  } catch (err) {
    if (err instanceof ApiError) throw pendingCheckoutError();
    throw err;
  }
}

function checkoutMatchesRequest(
  reservation: { priceId?: string; quantity?: number },
  snapshot: { items: { priceId: string; quantity: number }[] },
  request: CheckoutRequestBody,
): boolean {
  if (reservation.priceId && reservation.quantity) {
    return reservation.priceId === request.priceId && reservation.quantity === request.quantity;
  }
  return (
    snapshot.items.length === 1 &&
    snapshot.items[0].priceId === request.priceId &&
    snapshot.items[0].quantity === request.quantity
  );
}

function isRecoverableCheckoutTransaction(
  status: string | null,
  checkoutUrl: string | null,
): boolean {
  return !!checkoutUrl && (status === "draft" || status === "ready");
}

function pendingCheckoutError(): ApiError {
  return new ApiError(
    409,
    "billing_checkout_pending",
    "A subscription checkout is already in progress.",
  );
}

function checkoutConflictError(): ApiError {
  return new ApiError(
    409,
    "billing_checkout_conflict",
    "A different subscription checkout is already in progress.",
  );
}

function checkoutResponse(transaction: {
  transactionId: string;
  checkoutUrl: string | null;
}): Response {
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
  if (!body || typeof priceId !== "string" || priceId === "") {
    throw new ApiError(400, "invalid_request", "Missing Paddle price id.");
  }
  const kind = checkoutKindForPrice(priceId, env);
  if (!kind) {
    throw new ApiError(400, "invalid_request", "Unsupported Paddle price id.");
  }

  const quantity = parseCheckoutQuantity(body);
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

function parseCheckoutQuantity(body: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(body, "quantity")) return 1;
  const quantity = body.quantity;
  if (typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0) {
    return quantity;
  }
  throw new ApiError(400, "invalid_request", "Checkout quantity must be a positive integer.");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
