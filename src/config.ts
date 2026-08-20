// Central constants and the Worker environment binding shape.
//
// PRIVACY NOTE (backlog 56a): this Worker is a *stateless* drafting proxy. It
// holds nothing on disk, keeps no database, and — critically — never logs the
// contents of `system`/`messages` (the user's mail) or the model's reply. The
// only persisted state anywhere is a single `trialStartedAt` timestamp stored
// in the user's Clerk `privateMetadata`. If you are auditing this claim, the
// entire request path is: src/index.ts -> src/auth.ts -> src/anthropic.ts.
// Grep the repo for `console.` — the only logging is error *types*, never bodies.

export interface Env {
  // Secrets — provided via `wrangler secret put` (prod) or .dev.vars (local).
  CLERK_SECRET_KEY: string;
  ANTHROPIC_API_KEY: string;
  // Public — safe to commit / expose. Present for parity / future use.
  CLERK_PUBLISHABLE_KEY: string;
}

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

// Default drafting model. Mirrors the Sentwise app's current default.
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 4096;

// Full-featured trial length. Enforced server-side (56a decision).
export const TRIAL_DAYS = 14;
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;
