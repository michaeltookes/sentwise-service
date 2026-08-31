import { createClerkClient } from "@clerk/backend";
import { ApiError } from "./errors";
import type { Env } from "./config";
import { quotaRecordInterest } from "./quota-client";

/**
 * Topics a client may register interest in. Extend by adding an entry — the
 * allowlist keeps unknown/typo'd topics from writing junk to Clerk metadata.
 * For now the only demand signal we capture is the parked sign-in-with-Google
 * (OAuth) path surfaced when Workspace IMAP fails (item 75).
 */
export const INTEREST_TOPICS = ["google-oauth"] as const;
export type InterestTopic = (typeof INTEREST_TOPICS)[number];

const INTEREST_METADATA_KEY = "interest";

/**
 * POST /v1/interest — record that the authenticated user asked to be notified
 * when a parked capability ships (item 75: sign-in-with-Google demand capture).
 *
 * First click wins: the per-user Durable Object serializes interest writes, and
 * the ISO timestamp for a topic is written only when the key is absent, so
 * repeat calls are idempotent and still return 204. The stored value is a topic
 * key + timestamp on the user's OWN Clerk account — no mail, prompt, or draft
 * content. The top-level `interest` write merges into privateMetadata the same
 * way `trialStartedAt` does, preserving unrelated keys (trial, quota,
 * subscription). The maintainer reads demand by filtering Clerk users on
 * privateMetadata.interest — no new dashboard, nothing logged here.
 */
export async function recordInterest(
  userId: string,
  request: Request,
  env: Env,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be valid JSON.");
  }

  const topic = parseInterestTopic(body);

  await quotaRecordInterest(env, userId, { topic });

  return new Response(null, { status: 204 });
}

export async function recordInterestInClerk(
  userId: string,
  topic: InterestTopic,
  env: Env,
): Promise<{ recorded: boolean }> {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch {
    throw new ApiError(502, "interest_failed", "Could not record your interest. Please try again.");
  }

  const meta = (user.privateMetadata ?? {}) as Record<string, unknown>;
  const existing = isRecord(meta[INTEREST_METADATA_KEY]) ? meta[INTEREST_METADATA_KEY] : {};

  // First click wins: never overwrite an existing timestamp for this topic.
  if (typeof existing[topic] === "string") {
    return { recorded: false };
  }

  const interest = { ...existing, [topic]: new Date().toISOString() };
  try {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: { [INTEREST_METADATA_KEY]: interest },
    });
  } catch {
    throw new ApiError(502, "interest_failed", "Could not record your interest. Please try again.");
  }

  return { recorded: true };
}

export function parseInterestTopic(body: unknown): InterestTopic {
  const topic = isRecord(body) ? body.topic : undefined;
  if (typeof topic !== "string" || !isKnownTopic(topic)) {
    throw new ApiError(400, "invalid_request", "Unknown interest topic.");
  }
  return topic;
}

function isKnownTopic(value: string): value is InterestTopic {
  return (INTEREST_TOPICS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
