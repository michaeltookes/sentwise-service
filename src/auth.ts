import { verifyToken, createClerkClient } from "@clerk/backend";
import { CLERK_DELETE_TIMEOUT_MS, type Env } from "./config";
import { getCachedClerkUser, invalidateClerkUser } from "./clerk-user-cache";
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
    // S-L1: optionally pin the token's authorized party (`azp`). When
    // CLERK_AUTHORIZED_PARTIES is unset the option is omitted and verification is
    // unchanged. @clerk/backend only rejects a token whose `azp` is present AND
    // not in this list; a token with no `azp` (native-app session tokens can lack
    // it) still verifies — so this is a safe, config opt-in cutover control.
    const authorizedParties = parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES);
    const claims = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      ...(authorizedParties ? { authorizedParties } : {}),
    });
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

/**
 * Parse the comma-separated CLERK_AUTHORIZED_PARTIES env var into a trimmed,
 * de-duplicated allow-list, or `undefined` when unset/empty (verification then
 * pins no authorized party — the pre-S-L1 behavior). Exported for testing.
 */
export function parseAuthorizedParties(raw: string | undefined): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const parties = [
    ...new Set(
      raw
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== ""),
    ),
  ];
  return parties.length > 0 ? parties : undefined;
}

const TRIAL_METADATA_KEY = "trialStartedAt";

// Account lookup options.
//   initialize — start the trial (`trialStartedAt`) on this call if absent.
//   useCache   — serve/store the Clerk getUser via the short-TTL cache (S-M1).
//                Only pure-read, hammer-able routes (GET /v1/me) opt in; the draft
//                path (rate-limit reorder) and DELETE /v1/me read fresh.
export interface ResolveAccountOptions {
  initialize: boolean;
  useCache?: boolean;
}

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
  options: ResolveAccountOptions,
): Promise<AccountInfo> {
  const account = await resolveAccountIfExists(userId, env, options);
  if (account) return account;
  throw new ApiError(
    502,
    "account_lookup_failed",
    "Could not load your account. Please try again.",
  );
}

export async function resolveAccountIfExists(
  userId: string,
  env: Env,
  options: ResolveAccountOptions,
): Promise<AccountInfo | null> {
  let user;
  try {
    user = await getCachedClerkUser(env, userId, { useCache: options.useCache });
  } catch (err) {
    if (isClerkNotFoundError(err)) return null;
    throw new ApiError(
      502,
      "account_lookup_failed",
      "Could not load your account. Please try again.",
    );
  }

  return accountInfoFromUser(userId, env, user, options);
}

async function accountInfoFromUser(
  userId: string,
  env: Env,
  user: ClerkUserLike,
  options: ResolveAccountOptions,
): Promise<AccountInfo> {
  const meta = user.privateMetadata ?? {};
  let startedAt = typeof meta[TRIAL_METADATA_KEY] === "string" ? meta[TRIAL_METADATA_KEY] : null;
  // A corrupt/unparseable timestamp must not permanently expire the trial —
  // treat it as not-started so it re-initializes below.
  if (startedAt !== null && Number.isNaN(Date.parse(startedAt))) {
    startedAt = null;
  }

  if (!startedAt && options.initialize) {
    startedAt = new Date().toISOString();
    const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
    try {
      await clerk.users.updateUserMetadata(userId, {
        privateMetadata: { [TRIAL_METADATA_KEY]: startedAt },
      });
    } catch {
      throw new ApiError(502, "trial_init_failed", "Could not start your trial. Please try again.");
    }
    // The just-started trial must not be masked by an earlier cached (pre-init)
    // record served to a later GET /v1/me in this isolate.
    invalidateClerkUser(userId);
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

/** Clerk's SDK versions expose 404s with slightly different error shapes. */
export function isClerkNotFoundError(err: unknown): boolean {
  const record = isRecord(err) ? err : null;
  if (!record) return false;

  const status = record.status ?? record.statusCode;
  if (status === 404) return true;

  const errors = record.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((item) => {
    const error = isRecord(item) ? item : null;
    const code = error?.code;
    return code === "resource_not_found" || code === "not_found";
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Gate drafting access. Returns the resolved account when access is granted, else
 * throws 402. Access is granted by an active trial OR (56c) an active paid
 * subscription written by the Paddle webhook — so a paying customer is not blocked
 * when the 14-day trial clock runs out.
 */
export async function requireActiveTrial(userId: string, env: Env): Promise<AccountInfo> {
  const account = await resolveAccount(userId, env, { initialize: true });
  if (account.trial.active || hasPaidAccess(account.subscription)) {
    return account;
  }
  throw new ApiError(402, "trial_expired", "Your 14-day free trial has ended.", {
    trialEndsAt: account.trial.endsAt,
  });
}

/**
 * Whether a resolved subscription grants drafting access (56c). A paid tier is
 * good while `active`/`trialing`/`past_due` (past_due is a short billing grace);
 * `canceled`/`lapsed`, and the pre-purchase `trial`/`none` plans, are not.
 */
export function hasPaidAccess(subscription: Subscription): boolean {
  const paidPlan =
    subscription.plan === "starter" ||
    subscription.plan === "pro" ||
    subscription.plan === "unlimited" ||
    subscription.plan === "team";
  const activeStatus =
    subscription.status === "active" ||
    subscription.status === "trialing" ||
    subscription.status === "past_due";
  return paidPlan && activeStatus;
}

/**
 * Delete the Clerk user (73, account deletion). Idempotent: a user that is
 * already gone (Clerk 404) resolves successfully so DELETE /v1/me stays 204 on
 * retry. Definitive non-404 Clerk responses become a user-safe 502; rejected
 * requests are treated as unknown outcomes because Clerk may have committed the
 * delete before the transport failed.
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
    throw new ClerkDeletionOutcomeUnknownError();
  } finally {
    clearTimeout(timeout);
  }
}

interface ClerkUserLike {
  privateMetadata?: Record<string, unknown> | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
}

function primaryEmail(user: ClerkUserLike): string | null {
  const list = user.emailAddresses ?? [];
  const primary = list.find((e) => e.id === user.primaryEmailAddressId);
  return (primary ?? list[0])?.emailAddress ?? null;
}
