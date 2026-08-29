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

/** SHA-256 of the userId, hex-encoded. The raw userId never leaves this call. */
export async function hashUserId(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    const hashed = await hashUserId(ev.userId);
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
