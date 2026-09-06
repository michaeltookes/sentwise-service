// POST /v1/paddle/webhook handler (56c — checkout + licensing). Verifies the
// Paddle signature, maps the billing event to a Clerk user, and writes the
// entitlement into that user's `privateMetadata` so item 73 (subscription on
// /v1/me) and 56b (quota enforcement) pick it up. All the pure logic lives in
// src/paddle.ts; this file owns the Clerk + Paddle-API I/O.
//
// PRIVACY: this endpoint handles only plan/status/timestamps/URLs and
// price/subscription/customer ids (plus a customer email used solely to match an
// account when the checkout did not attach a Clerk user id). It never sees, logs,
// or stores prompt or draft content, and it never logs the raw webhook body.

import { createClerkClient } from "@clerk/backend";
import { DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC, PADDLE_SANDBOX_API_BASE, type Env } from "./config";
import { ApiError } from "./errors";
import { mondayStartUtc, numFrom } from "./metering";
import {
  buildSubscriptionRecord,
  clerkUserIdFromEvent,
  customerIdFromEvent,
  isSubscriptionEvent,
  overageDraftsFromEvent,
  parsePaddleEvent,
  planFromEvent,
  resolvePlanDraftLimit,
  subscriptionIdFromEvent,
  verifyPaddleSignature,
  type PaddleEvent,
} from "./paddle";

const HANDLED = new Set([
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "subscription.past_due",
  "transaction.completed",
]);

/**
 * Handle a Paddle webhook. Signature is verified against the exact raw body;
 * anything that fails verification is rejected with 401 and never processed. A
 * verified-but-unactionable event (unhandled type, unknown price, unmatched
 * account, replay, non-overage transaction) is acknowledged 200 so Paddle does
 * not retry pointlessly. Transient Clerk failures surface as 5xx so Paddle retries.
 */
export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  const toleranceSec = numFrom(
    env.PADDLE_WEBHOOK_TOLERANCE_SEC,
    DEFAULT_PADDLE_WEBHOOK_TOLERANCE_SEC,
  );
  const verification = await verifyPaddleSignature(
    rawBody,
    request.headers.get("Paddle-Signature") ?? request.headers.get("paddle-signature"),
    env.PADDLE_WEBHOOK_SECRET,
    Date.now(),
    toleranceSec,
  );
  if (!verification.ok) {
    // Never leak which check failed beyond a coarse reason; never process.
    throw new ApiError(401, "invalid_signature", "Webhook signature verification failed.");
  }

  const event = parsePaddleEvent(rawBody);
  if (!event) {
    throw new ApiError(400, "invalid_request", "Malformed webhook payload.");
  }

  if (!HANDLED.has(event.eventType)) {
    return ack({ ignored: "unhandled_event_type" });
  }

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  // Resolve the Clerk user: custom_data.clerkUserId (primary), else email match.
  const userId = await resolveClerkUserId(event, env, clerk);
  if (!userId) {
    return ack({ mapped: false });
  }

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch {
    // Transient — let Paddle retry.
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }
  const meta = (user.privateMetadata ?? {}) as Record<string, unknown>;

  if (isSubscriptionEvent(event.eventType)) {
    return await applySubscriptionEvent(event, env, clerk, userId, meta);
  }
  // transaction.completed → overage credit.
  return await applyOverageEvent(event, env, clerk, userId, meta);
}

// ---------------------------------------------------------------------------
// Subscription lifecycle → subscription record + per-tier quota limit.
// ---------------------------------------------------------------------------

async function applySubscriptionEvent(
  event: PaddleEvent,
  env: Env,
  clerk: ReturnType<typeof createClerkClient>,
  userId: string,
  meta: Record<string, unknown>,
): Promise<Response> {
  const mapped = planFromEvent(event);
  if (!mapped) {
    // A subscription for a price we don't recognize — nothing to entitle.
    return ack({ ignored: "unknown_price" });
  }

  const existingSub = asRecord(meta.subscription);
  // Idempotency: exact replay of an already-applied event.
  if (existingSub && existingSub.lastEventId === event.eventId) {
    return ack({ idempotent: true });
  }
  // Out-of-order guard: a strictly older event must not clobber a newer record.
  const now = Date.now();
  const incomingUpdatedAt = event.occurredAt ? Date.parse(event.occurredAt) : now;
  if (existingSub && typeof existingSub.updatedAt === "string") {
    const existingUpdatedAt = Date.parse(existingSub.updatedAt);
    if (
      !Number.isNaN(existingUpdatedAt) &&
      !Number.isNaN(incomingUpdatedAt) &&
      existingUpdatedAt > incomingUpdatedAt
    ) {
      return ack({ stale: true });
    }
  }

  // Best-effort manage-billing URL (Paddle omits management_urls from webhooks;
  // fetch via the API). Preserve any prior URL if the fetch is unavailable.
  const priorUrl =
    typeof existingSub?.manageBillingUrl === "string" ? existingSub.manageBillingUrl : null;
  const subscriptionId = subscriptionIdFromEvent(event);
  const fetchedUrl = subscriptionId ? await fetchManageBillingUrl(env, subscriptionId) : null;
  const manageBillingUrl = fetchedUrl ?? priorUrl;

  const record = buildSubscriptionRecord(event, mapped.plan, mapped.priceId, manageBillingUrl, now);

  // Set the tier's weekly draft limit as a per-account override, preserving any
  // other quota fields (purchased extras, token limit, overage idempotency marker).
  const existingQuota = asRecord(meta.quota) ?? {};
  const weeklyDraftLimit = resolvePlanDraftLimit(env, mapped.plan);
  const quota = { ...existingQuota, weeklyDraftLimit };

  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: { subscription: record, quota },
    });
  } catch {
    throw new ApiError(502, "entitlement_write_failed", "Could not record the subscription.");
  }
  return ack({ applied: true });
}

// ---------------------------------------------------------------------------
// transaction.completed → extra drafts stamped to the current weekly window.
// ---------------------------------------------------------------------------

async function applyOverageEvent(
  event: PaddleEvent,
  env: Env,
  clerk: ReturnType<typeof createClerkClient>,
  userId: string,
  meta: Record<string, unknown>,
): Promise<Response> {
  const credit = overageDraftsFromEvent(event, env);
  if (credit <= 0) {
    // Most transaction.completed events are subscription renewals, not overage.
    return ack({ ignored: "not_overage" });
  }

  const existingQuota = asRecord(meta.quota) ?? {};
  // Idempotency: an overage transaction we already credited.
  if (existingQuota.lastOverageEventId === event.eventId) {
    return ack({ idempotent: true });
  }

  // 56b requires extras to be stamped to the current Monday window to count;
  // accumulate within the same window, reset when the window has rolled.
  const now = Date.now();
  const windowStart = mondayStartUtc(now);
  const sameWindow = existingQuota.extraDraftsWindowStart === windowStart;
  const prevExtras =
    sameWindow && typeof existingQuota.extraDrafts === "number" ? existingQuota.extraDrafts : 0;

  const quota = {
    ...existingQuota,
    extraDrafts: prevExtras + credit,
    extraDraftsWindowStart: windowStart,
    lastOverageEventId: event.eventId,
  };

  try {
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { quota } });
  } catch {
    throw new ApiError(502, "entitlement_write_failed", "Could not record the purchase.");
  }
  return ack({ applied: true, extraDrafts: credit });
}

// ---------------------------------------------------------------------------
// Clerk user resolution.
// ---------------------------------------------------------------------------

async function resolveClerkUserId(
  event: PaddleEvent,
  env: Env,
  clerk: ReturnType<typeof createClerkClient>,
): Promise<string | null> {
  const fromCustomData = clerkUserIdFromEvent(event);
  if (fromCustomData) return fromCustomData;

  // Fallback: look the customer's email up in Clerk.
  const customerId = customerIdFromEvent(event);
  if (!customerId) return null;
  const email = await fetchCustomerEmail(env, customerId);
  if (!email) return null;
  try {
    const list: unknown = await clerk.users.getUserList({ emailAddress: [email] });
    const rec = asRecord(list);
    const arr = Array.isArray(rec?.data) ? rec.data : Array.isArray(list) ? list : [];
    const firstId = asRecord(arr[0])?.id;
    return typeof firstId === "string" ? firstId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Paddle REST reads (best-effort; failures degrade to null, never throw).
// ---------------------------------------------------------------------------

function paddleApiBase(env: Env): string {
  return env.PADDLE_API_BASE && env.PADDLE_API_BASE !== ""
    ? env.PADDLE_API_BASE
    : PADDLE_SANDBOX_API_BASE;
}

async function fetchManageBillingUrl(env: Env, subscriptionId: string): Promise<string | null> {
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

async function fetchCustomerEmail(env: Env, customerId: string): Promise<string | null> {
  if (!env.PADDLE_API_KEY) return null;
  try {
    const res = await fetch(`${paddleApiBase(env)}/customers/${encodeURIComponent(customerId)}`, {
      headers: {
        Authorization: `Bearer ${env.PADDLE_API_KEY}`,
        "content-type": "application/json",
      },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const data = asRecord(asRecord(body)?.data);
    const email = data?.email;
    return typeof email === "string" && email !== "" ? email : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function validHttpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/** Acknowledge a verified event. The body carries only a coarse outcome tag. */
function ack(extra: Record<string, unknown>): Response {
  return Response.json({ ok: true, ...extra });
}
