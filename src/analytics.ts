// Aggregate usage metrics for the margin dashboard (56b). Writes ONE datapoint
// per draft to Workers Analytics Engine — a SHA-256 hash of the userId (never
// the raw id), model, token counts, estimated cost, latency, and outcome. No
// prompt or draft content ever touches this module.

import type { Env } from "./config";
import { costUsd } from "./metering";

export interface UsageEvent {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: string; // "ok" or an error type
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pseudonymize the userId for aggregate metrics. The raw userId never leaves this
 * call. When `key` is provided (S-I2), it is a keyed HMAC-SHA256 — an attacker who
 * later obtains the dataset cannot re-identify a userId by hashing candidates
 * offline. Without a key it falls back to the original unkeyed SHA-256 so metrics
 * keep working before the secret is provisioned.
 */
export async function hashUserId(userId: string, key?: string): Promise<string> {
  const data = new TextEncoder().encode(userId);
  if (key) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return toHex(await crypto.subtle.sign("HMAC", cryptoKey, data));
  }
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

// 111 — admin comp grant/revoke audit trail. The repo's logging hygiene bans
// console.* entirely (scripts/check-no-body-logging.sh) and production retains
// no invocation logs, so the durable structured audit channel is the same
// Analytics Engine dataset as usage metrics: one datapoint per grant/revoke
// carrying the hashed account id (who), action (what), tier, and expiry. The
// `admin_comp_*` outcome blob never matches the margin dashboard's
// `blob3 = 'ok'` filter, so audit rows never skew margin aggregates. The admin
// route's JSON response is the human-readable record of the same fields.
export interface CompAuditEvent {
  userId: string;
  action: "grant" | "revoke";
  plan: string; // granted tier, or the revoked comp's tier ("none" when absent)
  expiresAt: string | null; // ISO expiry for grants; null for revokes
}

/** Best-effort audit write for an admin comp grant/revoke. Never throws. */
export async function recordCompAudit(env: Env, ev: CompAuditEvent): Promise<void> {
  const dataset = env.USAGE_ANALYTICS;
  if (!dataset) return;
  try {
    const hashed = await hashUserId(ev.userId, env.ANALYTICS_HASH_KEY);
    const expiresMs = ev.expiresAt ? Date.parse(ev.expiresAt) : 0;
    dataset.writeDataPoint({
      indexes: [hashed],
      blobs: [hashed, ev.plan, `admin_comp_${ev.action}`],
      doubles: [Number.isFinite(expiresMs) ? expiresMs : 0],
    });
  } catch {
    // Best-effort audit; the grant/revoke itself already succeeded in Clerk.
  }
}

/**
 * Best-effort aggregate metric write. Never throws and never blocks a draft: if
 * the binding is absent or the write fails, we simply skip it. Telemetry must
 * not be able to fail a user's request.
 */
export async function recordUsage(env: Env, ev: UsageEvent): Promise<void> {
  const dataset = env.USAGE_ANALYTICS;
  if (!dataset) return;
  try {
    const hashed = await hashUserId(ev.userId, env.ANALYTICS_HASH_KEY);
    dataset.writeDataPoint({
      indexes: [hashed],
      blobs: [hashed, ev.model, ev.outcome],
      doubles: [
        ev.inputTokens,
        ev.outputTokens,
        costUsd(ev.model, ev.inputTokens, ev.outputTokens),
        ev.latencyMs,
      ],
    });
  } catch {
    // Best-effort telemetry; never fail a draft because analytics was unavailable.
  }
}
