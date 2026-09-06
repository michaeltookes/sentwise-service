import { PADDLE_SANDBOX_API_BASE, type Env } from "./config";
import { ApiError } from "./errors";

export async function fetchPaddleCustomerEmail(
  env: Env,
  customerId: string,
): Promise<string | null> {
  if (!env.PADDLE_API_KEY) return null;
  try {
    const res = await fetch(`${paddleApiBase(env)}/customers/${encodeURIComponent(customerId)}`, {
      headers: {
        Authorization: `Bearer ${env.PADDLE_API_KEY}`,
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
