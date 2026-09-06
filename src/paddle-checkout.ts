import { PRICE_TO_PLAN, type Env } from "./config";
import { ApiError } from "./errors";
import { buildPaddleCheckoutCustomData } from "./paddle-account";
import { createPaddleCheckoutTransaction } from "./paddle-api";

const MAX_CHECKOUT_QUANTITY = 100;

export async function handlePaddleCheckout(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseCheckoutRequest(request, env);
  const transaction = await createPaddleCheckoutTransaction(env, {
    priceId: body.priceId,
    quantity: body.quantity,
    customData: await buildPaddleCheckoutCustomData(userId, env),
  });

  const res = Response.json(transaction);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

interface CheckoutRequestBody {
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
  if (!isAllowedCheckoutPrice(priceId, env)) {
    throw new ApiError(400, "invalid_request", "Unsupported Paddle price id.");
  }

  const quantity = positiveInt(body?.quantity) ?? 1;
  if (PRICE_TO_PLAN[priceId] && quantity !== 1) {
    throw new ApiError(400, "invalid_request", "Subscription checkouts must use quantity 1.");
  }
  if (quantity > MAX_CHECKOUT_QUANTITY) {
    throw new ApiError(400, "invalid_request", "Checkout quantity is too large.");
  }

  return { priceId, quantity };
}

function isAllowedCheckoutPrice(priceId: string, env: Env): boolean {
  return PRICE_TO_PLAN[priceId] !== undefined || priceId === env.EXTRA_DRAFTS_PRICE_ID;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
