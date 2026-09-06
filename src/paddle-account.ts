import { type Env } from "./config";
import { fetchPaddleCustomerEmail } from "./paddle-api";

export async function paddleCustomerMatchesAccount(
  user: unknown,
  meta: Record<string, unknown>,
  customerId: string | null,
  env: Env,
): Promise<boolean> {
  if (!customerId) return false;

  const storedCustomerId = storedPaddleCustomerId(meta.subscription);
  if (storedCustomerId) return storedCustomerId === customerId;

  const customerEmail = await fetchPaddleCustomerEmail(env, customerId);
  return customerEmail !== null && clerkUserHasEmail(user, customerEmail);
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

function clerkUserHasEmail(user: unknown, email: string): boolean {
  const record = asRecord(user);
  const addresses = Array.isArray(record?.emailAddresses) ? record.emailAddresses : [];
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  return addresses.some((item) => {
    const address = asRecord(item)?.emailAddress;
    return typeof address === "string" && address.trim().toLowerCase() === normalized;
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
