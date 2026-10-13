import { type Env } from "./config";
import { ApiError } from "./errors";
import {
  clerkUserIdFromCustomData,
  computeHmacSha256Hex,
  timingSafeEqualHex,
  type PaddleEvent,
} from "./paddle";

export function paddleCustomerMatchesAccount(
  _user: unknown,
  meta: Record<string, unknown>,
  customerId: string | null,
  _env: Env,
): boolean {
  return paddleCustomerMatchesStoredAccount(meta, customerId);
}

export function paddleCustomerMatchesStoredAccount(
  meta: Record<string, unknown>,
  customerId: string | null,
): boolean {
  if (!customerId) return false;
  return storedPaddleCustomerId(meta.subscription) === customerId;
}

export async function buildPaddleCheckoutCustomData(
  userId: string,
  env: Env,
  checkoutReservationId?: string,
): Promise<Record<string, string>> {
  const customData = {
    clerkUserId: userId,
    sentwiseCheckoutBinding: await paddleCheckoutBindingToken(userId, env),
  };
  return checkoutReservationId
    ? { ...customData, sentwiseCheckoutReservationId: checkoutReservationId }
    : customData;
}

export async function paddleCheckoutBindingMatchesEvent(
  event: PaddleEvent,
  userId: string,
  env: Env,
): Promise<boolean> {
  return paddleCheckoutBindingMatchesCustomData(event.data.custom_data, userId, env);
}

export async function paddleCheckoutBindingMatchesCustomData(
  customData: unknown,
  userId: string,
  env: Env,
): Promise<boolean> {
  if (clerkUserIdFromCustomData(customData) !== userId) return false;

  const token = checkoutBindingFromCustomData(customData);
  if (!token) return false;

  for (const secret of checkoutBindingVerificationSecrets(env)) {
    const expected = await paddleCheckoutBindingDigest(userId, secret);
    if (timingSafeEqualHex(expected, token)) return true;
  }
  return false;
}

export function storedPaddleCustomerId(rawSubscription: unknown): string | null {
  const subscription = asRecord(rawSubscription);
  const id = subscription?.paddleCustomerId;
  return typeof id === "string" && id !== "" ? id : null;
}

export function storedPaddleSubscriptionId(rawSubscription: unknown): string | null {
  const subscription = asRecord(rawSubscription);
  const id = subscription?.paddleSubscriptionId;
  return typeof id === "string" && id !== "" ? id : null;
}

export function supersededPaddleSubscriptionIds(rawSubscription: unknown): string[] {
  const subscription = asRecord(rawSubscription);
  const ids = Array.isArray(subscription?.supersededPaddleSubscriptionIds)
    ? subscription.supersededPaddleSubscriptionIds
    : [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

async function paddleCheckoutBindingToken(userId: string, env: Env): Promise<string> {
  return `v1:${await paddleCheckoutBindingDigest(userId, currentCheckoutBindingSecret(env))}`;
}

async function paddleCheckoutBindingDigest(userId: string, secret: string): Promise<string> {
  return computeHmacSha256Hex(secret, `sentwise:paddle-checkout:v1:${userId}`);
}

function currentCheckoutBindingSecret(env: Env): string {
  const secret = env.PADDLE_CHECKOUT_BINDING_SECRET || env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    throw new ApiError(503, "checkout_unavailable", "Checkout is not configured.");
  }
  return secret;
}

function checkoutBindingVerificationSecrets(env: Env): string[] {
  const secrets = [currentCheckoutBindingSecret(env), env.PADDLE_CHECKOUT_BINDING_PREVIOUS_SECRET];
  return [...new Set(secrets.filter((secret): secret is string => !!secret))];
}

function checkoutBindingFromCustomData(customData: unknown): string | null {
  const custom = asRecord(customData);
  const token = custom?.sentwiseCheckoutBinding;
  if (typeof token !== "string" || !token.startsWith("v1:")) return null;

  const digest = token.slice("v1:".length);
  return /^[0-9a-f]{64}$/i.test(digest) ? digest : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
