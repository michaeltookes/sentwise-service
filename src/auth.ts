import { verifyToken, createClerkClient } from "@clerk/backend";
import { CLERK_DELETE_TIMEOUT_MS, type Env } from "./config";
import { ApiError } from "./errors";
import { computeTrial, type TrialState } from "./trial";
import { parseQuotaOverride, type QuotaOverride } from "./metering";
import { deriveSubscription, type Subscription } from "./subscription";

export interface AuthedUser {
  userId: string;
}

export interface AccountInfo {
  userId: string;
  email: string | null;
  trial: TrialState;
  // 73: the account's subscription. Placeholder derived from the trial until 56c
  // writes privateMetadata.subscription; built explicitly, safe to expose on /v1/me.
  subscription: Subscription;
  // 56b: per-account limit overrides from privateMetadata.quota, read on the SAME
  // Clerk getUser as the trial (no extra Clerk round-trip). Not exposed on /v1/me.
  quotaOverride: QuotaOverride;
}

export class ClerkDeletionOutcomeUnknownError extends ApiError {
  constructor() {
    super(
      503,
      "account_deletion_status_unknown",
      "Account deletion is still being confirmed. Please try again.",
    );
    this.name = "ClerkDeletionOutcomeUnknownError";
  }
}

/**
 * Verify the Clerk session JWT from `Authorization: Bearer <token>`.
 * Throws ApiError(401) on missing/invalid tokens. Returns the Clerk user id.
 *
 * `verifyToken` fetches Clerk's JWKS automatically from the secret key and runs
 * on the Workers runtime (WebCrypto). We never log the token.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthedUser> {
  const header = request.headers.get("Authorization") ?? request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthenticated", "Sign in to use Sentwise AI.");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new ApiError(401, "unauthenticated", "Sign in to use Sentwise AI.");
  }

  try {
    const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    if (!claims.sub) {
      throw new ApiError(401, "unauthenticated", "Your session is invalid. Sign in again.");
    }
    return { userId: claims.sub };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Expired or malformed token — do not leak verifier internals.
    throw new ApiError(401, "session_invalid", "Your session has expired. Sign in again.");
  }
}

const TRIAL_METADATA_KEY = "trialStartedAt";

// TODO(56b): trial state is read from Clerk on every draft, costing two Clerk
// Backend API calls per request (getUser + updateUserMetadata on first draft).
// Cache it (KV/D1, short TTL keyed by userId) so steady-state drafts skip the
// lookup; metering (56b) will introduce that store anyway.
/**
 * Read the user's trial state, initializing `trialStartedAt` in Clerk
 * privateMetadata on the first authenticated call. Returns account info.
 *
 * `initialize` = false is used by GET /v1/me so merely viewing the account
 * never silently starts a trial; the trial starts on the first real draft.
 */
export async function resolveAccount(
  userId: string,
  env: Env,
  options: { initialize: boolean },
): Promise<AccountInfo> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch {
    throw new ApiError(
      502,
      "account_lookup_failed",
      "Could not load your account. Please try again.",
    );
  }

  const meta = (user.privateMetadata ?? {}) as Record<string, unknown>;
  let startedAt = typeof meta[TRIAL_METADATA_KEY] === "string" ? meta[TRIAL_METADATA_KEY] : null;
  // A corrupt/unparseable timestamp must not permanently expire the trial —
  // treat it as not-started so it re-initializes below.
  if (startedAt !== null && Number.isNaN(Date.parse(startedAt))) {
    startedAt = null;
  }

  if (!startedAt && options.initialize) {
    startedAt = new Date().toISOString();
    try {
      await clerk.users.updateUserMetadata(userId, {
        privateMetadata: { [TRIAL_METADATA_KEY]: startedAt },
      });
    } catch {
      throw new ApiError(502, "trial_init_failed", "Could not start your trial. Please try again.");
    }
  }

  const email = primaryEmail(user);
  const quotaOverride = parseQuotaOverride(meta.quota);

  // Report a not-yet-started trial when there's no stamp yet (viewing before the
  // first draft); otherwise compute it. Subscription is derived on the SAME
  // getUser — no extra Clerk round-trip (73).
  const trial: TrialState = startedAt
    ? computeTrial(startedAt)
    : { startedAt: "", endsAt: "", active: false };
  const subscription = deriveSubscription(trial, meta.subscription);

  return { userId, email, trial, subscription, quotaOverride };
}

/** Return whether Clerk still has this user; 404 means already deleted. */
export async function clerkUserExists(userId: string, env: Env): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLERK_DELETE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new ApiError(
      502,
      "account_lookup_failed",
      "Could not confirm your account deletion status. Please try again.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Enforce the trial: throw 402 when expired. Returns the resolved account. */
export async function requireActiveTrial(userId: string, env: Env): Promise<AccountInfo> {
  const account = await resolveAccount(userId, env, { initialize: true });
  if (!account.trial.active) {
    // TODO(56c): once checkout ships, allow paid accounts past this gate.
    throw new ApiError(402, "trial_expired", "Your 14-day free trial has ended.", {
      trialEndsAt: account.trial.endsAt,
    });
  }
  return account;
}

/**
 * Delete the Clerk user (73, account deletion). Idempotent: a user that is
 * already gone (Clerk 404) resolves successfully so DELETE /v1/me stays 204 on
 * retry. Any other Clerk failure becomes a user-safe 502 — no upstream detail
 * leaks, and (per the privacy guard) nothing is logged.
 *
 * The caller wraps this with the AccountQuota deletion barrier so in-flight
 * requests cannot mutate quota state while Clerk deletion is in progress.
 */
export async function deleteClerkUser(userId: string, env: Env): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLERK_DELETE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
    });
    if (res.ok || res.status === 404) return;
    throw new ApiError(
      502,
      "account_deletion_failed",
      "Could not delete your account. Please try again.",
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isAbortError(err)) throw new ClerkDeletionOutcomeUnknownError();
    throw new ApiError(
      502,
      "account_deletion_failed",
      "Could not delete your account. Please try again.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError"
  );
}

interface ClerkUserLike {
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
}

function primaryEmail(user: ClerkUserLike): string | null {
  const list = user.emailAddresses ?? [];
  const primary = list.find((e) => e.id === user.primaryEmailAddressId);
  return (primary ?? list[0])?.emailAddress ?? null;
}
