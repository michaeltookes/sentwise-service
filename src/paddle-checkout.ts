import { createClerkClient } from "@clerk/backend";
import { isClerkNotFoundError } from "./auth";
import { DEFAULT_EXTRA_DRAFTS_PER_UNIT, PRICE_TO_PLAN, type Env } from "./config";
import { ApiError } from "./errors";
import { numFrom } from "./metering";
import {
  buildPaddleCheckoutCustomData,
  paddleCheckoutBindingMatchesCustomData,
  storedPaddleCustomerId,
  storedPaddleSubscriptionId,
} from "./paddle-account";
import {
  cancelPaddleTransaction,
  createPaddleCheckoutTransaction,
  fetchPaddleTransactionSnapshot,
  findPaddleCheckoutTransactionByReservationId,
  type PaddleCheckoutReservationTransactionSnapshot,
  PaddleCheckoutCreationOutcomeUnknownError,
} from "./paddle-api";
import {
  quotaPeekPaddleOverageCheckout,
  quotaPeekPaddleSubscriptionCheckout,
  quotaRecordPaddleOverageCheckout,
  quotaRecordPaddleSubscriptionCheckout,
  quotaReleasePaddleOverageCheckout,
  quotaReleasePaddleSubscriptionCheckout,
  quotaReservePaddleOverageCheckout,
  quotaReservePaddleSubscriptionCheckout,
} from "./quota-client";

const MAX_CHECKOUT_QUANTITY = 100;
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);

interface PendingCheckoutTransaction {
  reservationId: string;
  transactionId: string;
  checkoutUrl: string | null;
}

interface PendingCheckoutReservation {
  pending: true;
  reservationId?: string;
  createdAt?: number;
  expiresAt?: number;
  transactionId?: string;
  checkoutUrl?: string | null;
  priceId?: string;
  quantity?: number;
  extraDrafts?: number;
  customerId?: string;
}

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

  assertCheckoutEligible(body, account.subscription, customerId);

  const checkoutReservationId = crypto.randomUUID();
  const existingTransaction = await reserveCheckout(
    env,
    userId,
    checkoutReservationId,
    body,
    customerId,
  );
  if (existingTransaction) {
    try {
      account = await loadCheckoutAccount(userId, env);
      customerId = storedPaddleCustomerId(account.subscription);
      assertCheckoutEligible(body, account.subscription, customerId);
    } catch (err) {
      if (isCheckoutEligibilityError(err)) {
        await cancelPaddleTransaction(env, existingTransaction.transactionId);
        await releaseCheckoutReservation(env, userId, body.kind, existingTransaction.reservationId);
      }
      throw err;
    }
    return checkoutResponse(existingTransaction);
  }

  try {
    account = await loadCheckoutAccount(userId, env);
    customerId = storedPaddleCustomerId(account.subscription);
    assertCheckoutEligible(body, account.subscription, customerId);
  } catch (err) {
    await releaseCheckoutReservation(env, userId, body.kind, checkoutReservationId).catch(
      () => undefined,
    );
    throw err;
  }

  let transaction;
  try {
    transaction = await createPaddleCheckoutTransaction(env, {
      priceId: body.priceId,
      quantity: body.quantity,
      customData: await buildPaddleCheckoutCustomData(userId, env, checkoutReservationId),
      customerId,
    });
  } catch (err) {
    if (!(err instanceof PaddleCheckoutCreationOutcomeUnknownError)) {
      await releaseCheckoutReservation(env, userId, body.kind, checkoutReservationId).catch(
        () => undefined,
      );
    }
    throw err;
  }

  let recordResult: Awaited<ReturnType<typeof recordCheckoutReservation>>;
  try {
    recordResult = await recordCheckoutReservation(env, userId, body, checkoutReservationId, {
      transactionId: transaction.transactionId,
      checkoutUrl: transaction.checkoutUrl,
      customerId,
    });
  } catch (err) {
    try {
      await cancelPaddleTransaction(env, transaction.transactionId);
      await releaseCheckoutReservation(env, userId, body.kind, checkoutReservationId).catch(
        () => undefined,
      );
    } catch {
      // Keep the reservation blocking retries if the payable transaction may still exist.
    }
    throw err;
  }
  if ("stale" in recordResult || "unusable" in recordResult) {
    await cancelPaddleTransaction(env, transaction.transactionId);
    await releaseCheckoutReservation(env, userId, body.kind, checkoutReservationId);
    if ("unusable" in recordResult) {
      throw subscriptionRequiredError();
    }
    throw pendingCheckoutError();
  }

  return checkoutResponse(transaction);
}

function assertCheckoutEligible(
  body: CheckoutRequestBody,
  rawSubscription: unknown,
  customerId: string | null,
): void {
  if (body.kind === "subscription" && hasActivePaddleSubscription(rawSubscription)) {
    throw new ApiError(
      409,
      "billing_subscription_active",
      "Manage your current subscription before starting a new one.",
    );
  }
  if (body.kind === "overage" && !hasActivePaddleSubscription(rawSubscription)) {
    throw subscriptionRequiredError();
  }
  if (body.kind === "overage" && !customerId) {
    throw new ApiError(
      409,
      "billing_customer_not_bound",
      "Your Paddle customer is not ready for overage checkout yet.",
    );
  }
}

export async function hasOpenPaddleCheckout(userId: string, env: Env): Promise<boolean> {
  const now = Date.now();
  const subscriptionReservation = await quotaPeekPaddleSubscriptionCheckout(env, userId, { now });
  if (await hasOpenCheckoutReservation(env, userId, "subscription", subscriptionReservation)) {
    return true;
  }

  const overageReservation = await quotaPeekPaddleOverageCheckout(env, userId, { now });
  return await hasOpenCheckoutReservation(env, userId, "overage", overageReservation);
}

export const hasOpenPaddleSubscriptionCheckout = hasOpenPaddleCheckout;

async function hasOpenCheckoutReservation(
  env: Env,
  userId: string,
  kind: CheckoutRequestBody["kind"],
  reservation: { pending: false } | PendingCheckoutReservation,
): Promise<boolean> {
  if (!reservation.pending) return false;
  const reservationId = reservation.reservationId;
  if (!reservationId) return true;
  if (!reservation.transactionId) {
    return await hasOpenUnrecordedCheckoutReservation(env, userId, kind, {
      ...reservation,
      reservationId,
    });
  }

  const snapshot = await pendingCheckoutTransactionSnapshot(env, reservation.transactionId);
  if (!snapshot || snapshot.status === "canceled") {
    await releaseCheckoutReservation(env, userId, kind, reservationId);
    return false;
  }

  return true;
}

async function reserveCheckout(
  env: Env,
  userId: string,
  reservationId: string,
  request: CheckoutRequestBody,
  customerId: string | null,
): Promise<PendingCheckoutTransaction | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const reservation =
      request.kind === "subscription"
        ? await quotaReservePaddleSubscriptionCheckout(env, userId, {
            now: Date.now(),
            reservationId,
            priceId: request.priceId,
            quantity: request.quantity,
          })
        : await quotaReservePaddleOverageCheckout(env, userId, {
            now: Date.now(),
            reservationId,
            priceId: request.priceId,
            quantity: request.quantity,
            extraDrafts: overageExtraDraftsForCheckout(request.quantity, env),
            customerId: customerId ?? "",
          });
    if ("reserved" in reservation) return null;

    const pending = await recoverOrReleasePendingCheckout(env, userId, reservation, request);
    if (pending) return pending;
  }
  throw pendingCheckoutError();
}

async function recordCheckoutReservation(
  env: Env,
  userId: string,
  request: CheckoutRequestBody,
  reservationId: string,
  transaction: {
    transactionId: string;
    checkoutUrl: string | null;
    customerId: string | null;
  },
): Promise<{ recorded: true } | { stale: true } | { unusable: true }> {
  if (request.kind === "subscription") {
    return quotaRecordPaddleSubscriptionCheckout(env, userId, {
      reservationId,
      transactionId: transaction.transactionId,
      checkoutUrl: transaction.checkoutUrl,
      priceId: request.priceId,
      quantity: request.quantity,
    });
  }
  return quotaRecordPaddleOverageCheckout(env, userId, {
    reservationId,
    transactionId: transaction.transactionId,
    checkoutUrl: transaction.checkoutUrl,
    priceId: request.priceId,
    quantity: request.quantity,
    customerId: transaction.customerId ?? "",
  });
}

function releaseCheckoutReservation(
  env: Env,
  userId: string,
  kind: CheckoutRequestBody["kind"],
  reservationId: string,
): Promise<{ released: true }> {
  return kind === "subscription"
    ? quotaReleasePaddleSubscriptionCheckout(env, userId, reservationId)
    : quotaReleasePaddleOverageCheckout(env, userId, reservationId);
}

async function recoverOrReleasePendingCheckout(
  env: Env,
  userId: string,
  reservation: PendingCheckoutReservation,
  request: CheckoutRequestBody,
): Promise<PendingCheckoutTransaction | null> {
  const reservationId = reservation.reservationId;
  if (!reservationId) {
    throw pendingCheckoutError();
  }
  if (!reservation.transactionId) {
    return await recoverOrReleaseUnrecordedCheckout(
      env,
      userId,
      { ...reservation, reservationId },
      request,
    );
  }

  const snapshot = await pendingCheckoutTransactionSnapshot(env, reservation.transactionId);
  if (!snapshot || snapshot.status === "canceled") {
    await releaseCheckoutReservation(env, userId, request.kind, reservationId);
    return null;
  }
  const checkoutUrl = snapshot.checkoutUrl ?? reservation.checkoutUrl ?? null;
  if (isRecoverableCheckoutTransaction(snapshot.status, checkoutUrl)) {
    if (!checkoutMatchesRequest(reservation, snapshot, request)) {
      throw checkoutConflictError();
    }
    return {
      reservationId,
      transactionId: reservation.transactionId,
      checkoutUrl,
    };
  }
  throw pendingCheckoutError();
}

async function recoverOrReleaseUnrecordedCheckout(
  env: Env,
  userId: string,
  reservation: PendingCheckoutReservation & { reservationId: string },
  request: CheckoutRequestBody,
): Promise<PendingCheckoutTransaction | null> {
  if (!reservationExpired(reservation)) throw pendingCheckoutError();

  const snapshot = await unrecordedCheckoutTransactionSnapshot(env, userId, reservation);
  if (!snapshot || snapshot.status === "canceled") {
    await releaseCheckoutReservation(env, userId, request.kind, reservation.reservationId);
    return null;
  }

  const checkoutUrl = snapshot.checkoutUrl ?? reservation.checkoutUrl ?? null;
  if (!isRecoverableCheckoutTransaction(snapshot.status, checkoutUrl)) {
    throw pendingCheckoutError();
  }
  if (!checkoutMatchesRequest(reservation, snapshot, request)) {
    throw checkoutConflictError();
  }

  const recordResult = await recordCheckoutReservation(
    env,
    userId,
    request,
    reservation.reservationId,
    {
      transactionId: snapshot.transactionId,
      checkoutUrl,
      customerId: snapshot.customerId ?? reservation.customerId ?? null,
    },
  );
  if ("recorded" in recordResult) {
    return {
      reservationId: reservation.reservationId,
      transactionId: snapshot.transactionId,
      checkoutUrl,
    };
  }
  if ("unusable" in recordResult) {
    await cancelPaddleTransaction(env, snapshot.transactionId);
    await releaseCheckoutReservation(env, userId, request.kind, reservation.reservationId);
    throw subscriptionRequiredError();
  }
  throw pendingCheckoutError();
}

async function hasOpenUnrecordedCheckoutReservation(
  env: Env,
  userId: string,
  kind: CheckoutRequestBody["kind"],
  reservation: PendingCheckoutReservation & { reservationId: string },
): Promise<boolean> {
  if (!reservationExpired(reservation)) return true;
  let snapshot: PaddleCheckoutReservationTransactionSnapshot | null;
  try {
    snapshot = await unrecordedCheckoutTransactionSnapshot(env, userId, reservation);
  } catch (err) {
    if (err instanceof ApiError) return true;
    throw err;
  }
  if (!snapshot || snapshot.status === "canceled") {
    await releaseCheckoutReservation(env, userId, kind, reservation.reservationId);
    return false;
  }
  return true;
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

async function unrecordedCheckoutTransactionSnapshot(
  env: Env,
  userId: string,
  reservation: PendingCheckoutReservation & { reservationId: string },
): Promise<PaddleCheckoutReservationTransactionSnapshot | null> {
  if (typeof reservation.createdAt !== "number" || !Number.isFinite(reservation.createdAt)) {
    throw pendingCheckoutError();
  }
  try {
    const snapshot = await findPaddleCheckoutTransactionByReservationId(env, {
      reservationId: reservation.reservationId,
      createdAt: reservation.createdAt,
      expiresAt: reservation.expiresAt,
      customerId: reservation.customerId,
    });
    if (
      snapshot &&
      !(await paddleCheckoutBindingMatchesCustomData(snapshot.customData, userId, env))
    ) {
      throw pendingCheckoutError();
    }
    return snapshot;
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

function reservationExpired(reservation: { expiresAt?: number }): boolean {
  return typeof reservation.expiresAt === "number" && Number.isFinite(reservation.expiresAt)
    ? Date.now() > reservation.expiresAt
    : false;
}

function isRecoverableCheckoutTransaction(
  status: string | null,
  checkoutUrl: string | null,
): boolean {
  return !!checkoutUrl && (status === "draft" || status === "ready");
}

function pendingCheckoutError(): ApiError {
  return new ApiError(409, "billing_checkout_pending", "A Paddle checkout is already in progress.");
}

function subscriptionRequiredError(): ApiError {
  return new ApiError(
    409,
    "billing_subscription_required",
    "An active Paddle subscription is required before buying extra drafts.",
  );
}

function isCheckoutEligibilityError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.type === "billing_subscription_active" ||
      err.type === "billing_subscription_required" ||
      err.type === "billing_customer_not_bound")
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
  const res = Response.json({
    transactionId: transaction.transactionId,
    checkoutUrl: transaction.checkoutUrl,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function overageExtraDraftsForCheckout(quantity: number, env: Env): number {
  return Math.max(
    0,
    Math.floor(quantity * numFrom(env.EXTRA_DRAFTS_PER_UNIT, DEFAULT_EXTRA_DRAFTS_PER_UNIT)),
  );
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
