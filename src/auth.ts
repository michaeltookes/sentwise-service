import { verifyToken, createClerkClient } from "@clerk/backend";
import type { Env } from "./config";
import { ApiError } from "./errors";
import { computeTrial, type TrialState } from "./trial";

export interface AuthedUser {
  userId: string;
}

export interface AccountInfo {
  userId: string;
  email: string | null;
  trial: TrialState;
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

  if (!startedAt) {
    // /v1/me before the trial has started (no draft yet): report a not-yet-started trial.
    return { userId, email, trial: { startedAt: "", endsAt: "", active: false } };
  }

  return { userId, email, trial: computeTrial(startedAt) };
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

interface ClerkUserLike {
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
}

function primaryEmail(user: ClerkUserLike): string | null {
  const list = user.emailAddresses ?? [];
  const primary = list.find((e) => e.id === user.primaryEmailAddressId);
  return (primary ?? list[0])?.emailAddress ?? null;
}
