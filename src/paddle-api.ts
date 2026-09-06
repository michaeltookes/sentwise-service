import { PADDLE_SANDBOX_API_BASE, type Env } from "./config";
import { ApiError } from "./errors";

export interface PaddleCheckoutTransactionInput {
  priceId: string;
  quantity: number;
  customData: Record<string, string>;
  customerId?: string | null;
}

export interface PaddleCheckoutTransaction {
  transactionId: string;
  checkoutUrl: string | null;
}

export interface PaddleSubscriptionSnapshot {
  customerId: string | null;
  status: string | null;
}

export interface PaddleTransactionSnapshot {
  customerId: string | null;
  customData: Record<string, unknown> | null;
  status: string | null;
  checkoutUrl: string | null;
}

export type PaddleManagementAction = "update_payment_method" | "cancel";

export async function fetchPaddleCustomerEmail(
  env: Env,
  customerId: string,
): Promise<string | null> {
  const apiKey = requirePaddleApiKey(
    "customer_lookup_failed",
    "Could not resolve the customer.",
    env,
  );
  try {
    const res = await fetch(`${paddleApiBase(env)}/customers/${encodeURIComponent(customerId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ApiError(502, "customer_lookup_failed", "Could not resolve the customer.");
    }
    const body: unknown = await res.json();
    const data = asRecord(asRecord(body)?.data);
    const email = data?.email;
    return typeof email === "string" && email !== "" ? email : null;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, "customer_lookup_failed", "Could not resolve the customer.");
  }
}

export async function createPaddleCheckoutTransaction(
  env: Env,
  input: PaddleCheckoutTransactionInput,
): Promise<PaddleCheckoutTransaction> {
  const apiKey = requirePaddleApiKey("checkout_unavailable", "Could not start checkout.", env);
  try {
    const payload: Record<string, unknown> = {
      collection_mode: "automatic",
      items: [{ price_id: input.priceId, quantity: input.quantity }],
      custom_data: input.customData,
      checkout: { url: null },
    };
    if (input.customerId) {
      payload.customer_id = input.customerId;
    }

    const res = await fetch(`${paddleApiBase(env)}/transactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new ApiError(502, "checkout_unavailable", "Could not start checkout.");
    }

    const body: unknown = await res.json();
    const data = asRecord(asRecord(body)?.data);
    const transactionId = data?.id;
    if (typeof transactionId !== "string" || transactionId === "") {
      throw new ApiError(502, "checkout_unavailable", "Could not start checkout.");
    }

    return {
      transactionId,
      checkoutUrl: validHttpsUrl(data ? asRecord(data.checkout)?.url : undefined),
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, "checkout_unavailable", "Could not start checkout.");
  }
}

export async function fetchPaddleManagementUrl(
  env: Env,
  subscriptionId: string,
  action: PaddleManagementAction,
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
    const candidate = urls?.[action];
    return validHttpsUrl(candidate);
  } catch {
    return null;
  }
}

export async function fetchPaddleTransactionSnapshot(
  env: Env,
  transactionId: string,
): Promise<PaddleTransactionSnapshot | null> {
  const apiKey = requirePaddleApiKey(
    "transaction_lookup_failed",
    "Could not confirm the transaction.",
    env,
  );
  try {
    const res = await fetch(
      `${paddleApiBase(env)}/transactions/${encodeURIComponent(transactionId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ApiError(502, "transaction_lookup_failed", "Could not confirm the transaction.");
    }
    const body: unknown = await res.json();
    const data = asRecord(asRecord(body)?.data);
    const customerId = data?.customer_id;
    const status = data?.status;
    return {
      customerId: typeof customerId === "string" && customerId !== "" ? customerId : null,
      customData: asRecord(data?.custom_data),
      status: typeof status === "string" && status !== "" ? status : null,
      checkoutUrl: validHttpsUrl(data ? asRecord(data.checkout)?.url : undefined),
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, "transaction_lookup_failed", "Could not confirm the transaction.");
  }
}

export async function fetchPaddleSubscriptionSnapshot(
  env: Env,
  subscriptionId: string,
): Promise<PaddleSubscriptionSnapshot | null> {
  const apiKey = requirePaddleApiKey(
    "subscription_lookup_failed",
    "Could not confirm the subscription.",
    env,
  );
  try {
    const res = await fetch(
      `${paddleApiBase(env)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ApiError(502, "subscription_lookup_failed", "Could not confirm the subscription.");
    }
    const body: unknown = await res.json();
    const data = asRecord(asRecord(body)?.data);
    const customerId = data?.customer_id;
    const status = data?.status;
    return {
      customerId: typeof customerId === "string" && customerId !== "" ? customerId : null,
      status: typeof status === "string" && status !== "" ? status : null,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, "subscription_lookup_failed", "Could not confirm the subscription.");
  }
}

function paddleApiBase(env: Env): string {
  return env.PADDLE_API_BASE && env.PADDLE_API_BASE !== ""
    ? env.PADDLE_API_BASE
    : PADDLE_SANDBOX_API_BASE;
}

function requirePaddleApiKey(type: string, message: string, env: Env): string {
  if (env.PADDLE_API_KEY) return env.PADDLE_API_KEY;
  throw new ApiError(502, type, message);
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
