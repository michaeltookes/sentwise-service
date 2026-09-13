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
