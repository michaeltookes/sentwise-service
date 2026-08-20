import { describe, it, expect } from "vitest";
import { computeTrial } from "../src/trial";
import { TRIAL_MS } from "../src/config";

describe("computeTrial", () => {
  it("marks a fresh trial active with a 14-day window", () => {
    const start = "2026-08-20T00:00:00.000Z";
    const now = Date.parse(start) + 1000;
    const t = computeTrial(start, now);
    expect(t.startedAt).toBe(start);
    expect(t.endsAt).toBe(new Date(Date.parse(start) + TRIAL_MS).toISOString());
    expect(t.active).toBe(true);
  });

  it("marks a trial expired once the window has passed", () => {
    const start = "2026-08-01T00:00:00.000Z";
    const now = Date.parse(start) + TRIAL_MS + 1;
    expect(computeTrial(start, now).active).toBe(false);
  });

  it("treats the exact end instant as expired (active is strictly before end)", () => {
    const start = "2026-08-01T00:00:00.000Z";
    const now = Date.parse(start) + TRIAL_MS;
    expect(computeTrial(start, now).active).toBe(false);
  });
});
