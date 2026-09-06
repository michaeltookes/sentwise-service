import { type Env } from "./config";
import { ApiError } from "./errors";
import {
  clerkUserIdFromEvent,
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
): Promise<Record<string, string>> {
  return {
    clerkUserId: userId,
    sentwiseCheckoutBinding: await paddleCheckoutBindingToken(userId, env),
  };
}

export async function paddleCheckoutBindingMatchesEvent(
  event: PaddleEvent,
  userId: string,
  env: Env,
): Promise<boolean> {
  if (clerkUserIdFromEvent(event) !== userId) return false;

  const token = checkoutBindingFromEvent(event);
  if (!token) return false;

  const expected = await paddleCheckoutBindingDigest(userId, env);
  return timingSafeEqualHex(expected, token);
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
  return `v1:${await paddleCheckoutBindingDigest(userId, env)}`;
}

async function paddleCheckoutBindingDigest(userId: string, env: Env): Promise<string> {
  if (!env.PADDLE_WEBHOOK_SECRET) {
    throw new ApiError(503, "checkout_unavailable", "Checkout is not configured.");
  }
  return computeHmacSha256Hex(env.PADDLE_WEBHOOK_SECRET, `sentwise:paddle-checkout:v1:${userId}`);
}

function checkoutBindingFromEvent(event: PaddleEvent): string | null {
  const custom = asRecord(event.data.custom_data);
  const token = custom?.sentwiseCheckoutBinding;
  if (typeof token !== "string" || !token.startsWith("v1:")) return null;

  const digest = token.slice("v1:".length);
  return /^[0-9a-f]{64}$/i.test(digest) ? digest : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
