import { TRIAL_MS } from "./config";

export interface TrialState {
  startedAt: string; // ISO 8601
  endsAt: string; // ISO 8601
  active: boolean;
}

/**
 * Pure trial computation — no I/O, so it is trivially unit-testable.
 * `startedAtIso` is the value stored in the user's Clerk privateMetadata.
 */
export function computeTrial(startedAtIso: string, now: number = Date.now()): TrialState {
  const startedMs = Date.parse(startedAtIso);
  const endsMs = startedMs + TRIAL_MS;
  return {
    startedAt: new Date(startedMs).toISOString(),
    endsAt: new Date(endsMs).toISOString(),
    active: now < endsMs,
  };
}
