// Comp entitlement admin surface (app-repo backlog item 111). /admin/comp —
// maintainer-only, guarded by the same ADMIN_TOKEN bearer gate as /admin/margin
// (404 when the token is unset, 401 on a missing/empty/wrong bearer).
//
//   GET    /admin/comp?email=... | ?userId=...  -> inspect an account's comp
//   POST   /admin/comp  { email|userId, plan, days?|expiresAt? } -> grant
//   DELETE /admin/comp  { email|userId }        -> revoke (back to natural state)
//
// The grant writes ONLY `privateMetadata.comp` — it never touches the Paddle
// subscription record or the webhook-managed quota key, so a comp layers over
// real billing state instead of clobbering it (see src/comp.ts for the
// precedence rules). Revoke deletes the key. Each grant/revoke emits a
// structured audit datapoint (hashed account id / action / tier / expiry) via
// recordCompAudit and returns the same fields in the JSON response.
//
// PRIVACY: handles only account ids, email addresses, plan enums, and
// timestamps — never prompt or draft content, and never the admin token.

import { createClerkClient } from "@clerk/backend";
import { authorizeAdmin } from "./admin";
import { recordCompAudit } from "./analytics";
import { isClerkNotFoundError, primaryEmail } from "./auth";
import { invalidateClerkUser } from "./clerk-user-cache";
import {
  COMP_DEFAULT_DAYS,
  COMP_MAX_DAYS,
  compIsActive,
  isCompPlan,
  parseCompEntitlement,
  type CompEntitlement,
} from "./comp";
import type { Env } from "./config";
import { ApiError, jsonError } from "./errors";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleAdminComp(request: Request, env: Env): Promise<Response> {
  const denied = await authorizeAdmin(request, env);
  if (denied) return denied;

  try {
    switch (request.method) {
      case "GET":
        return await inspectComp(request, env);
      case "POST":
        return await grantComp(request, env);
      case "DELETE":
        return await revokeComp(request, env);
      default:
        return jsonError(405, "method_not_allowed", "Method not allowed.");
    }
  } catch (err) {
    if (err instanceof ApiError) return err.toResponse();
    return jsonError(500, "internal_error", "Something went wrong. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async function inspectComp(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const target = parseTarget({
    userId: params.get("userId") ?? undefined,
    email: params.get("email") ?? undefined,
  });
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const { userId, user } = await resolveTargetUser(clerk, target);
  const comp = parseCompEntitlement((user.privateMetadata ?? {}).comp);
  return Response.json({
    userId,
    email: primaryEmail(user),
    comp,
    active: comp !== null && compIsActive(comp, Date.now()),
  });
}

async function grantComp(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  const target = parseTarget(body);
  const plan = body.plan;
  if (!isCompPlan(plan)) {
    throw new ApiError(
      400,
      "invalid_request",
      "plan must be one of starter, pro, unlimited (team is reserved and cannot be comped).",
    );
  }

  const now = Date.now();
  const expiresAt = resolveExpiry(body, now);
  const grantedAt = new Date(now).toISOString();
  const comp: CompEntitlement = { plan, grantedAt, expiresAt };

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const { userId, user } = await resolveTargetUser(clerk, target);
  await writeComp(clerk, userId, comp);
  invalidateClerkUser(userId);
  await recordCompAudit(env, { userId, action: "grant", plan, expiresAt });

  return Response.json({
    granted: true,
    userId,
    email: primaryEmail(user),
    plan,
    grantedAt,
    expiresAt,
  });
}

async function revokeComp(request: Request, env: Env): Promise<Response> {
  const body = await jsonBody(request);
  const target = parseTarget(body);

  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  const { userId, user } = await resolveTargetUser(clerk, target);
  const previous = parseCompEntitlement((user.privateMetadata ?? {}).comp);
  await writeComp(clerk, userId, null);
  invalidateClerkUser(userId);
  await recordCompAudit(env, {
    userId,
    action: "revoke",
    plan: previous?.plan ?? "none",
    expiresAt: null,
  });

  return Response.json({
    revoked: true,
    userId,
    email: primaryEmail(user),
    previous,
  });
}

// ---------------------------------------------------------------------------
// Account addressing. The worker keys accounts by Clerk user id; email lookup
// rides Clerk's getUserList (the same mechanism the Paddle webhook uses), so
// the owner can address the QA account by its email address.
// ---------------------------------------------------------------------------

interface CompTarget {
  userId?: string;
  email?: string;
}

function parseTarget(raw: { userId?: unknown; email?: unknown }): CompTarget {
  const userId = nonEmptyString(raw.userId);
  const email = nonEmptyString(raw.email);
  if ((userId === null) === (email === null)) {
    throw new ApiError(400, "invalid_request", "Provide exactly one of userId or email.");
  }
  return userId !== null ? { userId } : { email: email as string };
}

type ClerkClient = ReturnType<typeof createClerkClient>;
type ClerkUser = Awaited<ReturnType<ClerkClient["users"]["getUser"]>>;

async function resolveTargetUser(
  clerk: ClerkClient,
  target: CompTarget,
): Promise<{ userId: string; user: ClerkUser }> {
  const userId = target.userId ?? (await userIdForEmail(clerk, target.email as string));
  try {
    const user = await clerk.users.getUser(userId);
    return { userId, user };
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "No account matches that userId.");
    }
    throw new ApiError(502, "account_lookup_failed", "Could not load the account.");
  }
}

async function userIdForEmail(clerk: ClerkClient, email: string): Promise<string> {
  let list: unknown;
  try {
    list = await clerk.users.getUserList({ emailAddress: [email] });
  } catch {
    throw new ApiError(502, "account_lookup_failed", "Could not look the account up by email.");
  }
  const rec = asRecord(list);
  const arr = Array.isArray(rec?.data) ? rec.data : Array.isArray(list) ? list : [];
  const ids = arr
    .map((item) => asRecord(item)?.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  if (ids.length === 0) {
    throw new ApiError(404, "account_not_found", "No account matches that email.");
  }
  if (new Set(ids).size > 1) {
    throw new ApiError(
      409,
      "account_ambiguous",
      "More than one account matches that email; address it by userId instead.",
    );
  }
  return ids[0];
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

async function writeComp(
  clerk: ClerkClient,
  userId: string,
  comp: CompEntitlement | null,
): Promise<void> {
  try {
    // Clerk merges privateMetadata top-level keys; null deletes the key. Only
    // `comp` is ever written — subscription/quota/trial keys are untouched.
    await clerk.users.updateUserMetadata(userId, { privateMetadata: { comp } });
  } catch (err) {
    if (isClerkNotFoundError(err)) {
      throw new ApiError(404, "account_not_found", "No account matches that userId.");
    }
    throw new ApiError(502, "entitlement_write_failed", "Could not write the comp entitlement.");
  }
}

function resolveExpiry(body: Record<string, unknown>, now: number): string {
  const hasDays = body.days !== undefined && body.days !== null;
  const hasExpiresAt = body.expiresAt !== undefined && body.expiresAt !== null;
  if (hasDays && hasExpiresAt) {
    throw new ApiError(400, "invalid_request", "Provide days or expiresAt, not both.");
  }
  if (hasExpiresAt) {
    const ms = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    if (Number.isNaN(ms)) {
      throw new ApiError(400, "invalid_request", "expiresAt must be an ISO 8601 timestamp.");
    }
    if (ms <= now || ms > now + COMP_MAX_DAYS * DAY_MS) {
      throw new ApiError(
        400,
        "invalid_request",
        `expiresAt must be in the future and within ${COMP_MAX_DAYS} days.`,
      );
    }
    return new Date(ms).toISOString();
  }
  let days = COMP_DEFAULT_DAYS;
  if (hasDays) {
    if (
      typeof body.days !== "number" ||
      !Number.isInteger(body.days) ||
      body.days < 1 ||
      body.days > COMP_MAX_DAYS
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        `days must be an integer between 1 and ${COMP_MAX_DAYS}.`,
      );
    }
    days = body.days;
  }
  return new Date(now + days * DAY_MS).toISOString();
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
  }
  const record = asRecord(body);
  if (!record) {
    throw new ApiError(400, "invalid_request", "Request body must be an object.");
  }
  return record;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
