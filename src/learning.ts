// 139: voice learning is a server-defined operation, never a client-shaped
// draft. The server owns the system prompt, output constraints and input cap, so
// the `voice_learning` purpose cannot be used to run arbitrary drafting content
// outside the monthly draft quota. All learning constants live here.

import type { DraftRequest } from "./anthropic";
import { ApiError } from "./errors";

/** Independent per-account allowance: learning calls per UTC month (not drafts). */
export const LEARNING_MONTHLY_LIMIT = 10;
/** Cap on the single user message (the app sends up to 12 samples x 1500 chars). */
export const LEARNING_MAX_INPUT_CHARS = 24_000;
export const LEARNING_MAX_TOKENS = 1024;
export const LEARNING_TEMPERATURE = 0.3;

export const LEARNING_SYSTEM_PROMPT =
  "You analyze a person's outgoing emails and produce a concise, reusable profile of their writing voice. " +
  "Respond with ONLY a JSON object — no prose, no code fences — matching exactly these keys: " +
  "greeting (string), signOff (string), formality (string), tone (string), averageLength (string), " +
  "commonPhrases (array of strings, up to 6), summary (string, 2-3 sentences). " +
  "Base every field only on how the person writes. If a field is unclear, use an empty string or empty array.";

/**
 * Build the request actually forwarded for a learning call. The client's system
 * prompt, token cap, temperature and extra messages are ignored or rejected; only
 * one user message (the samples) is taken from the client.
 */
export function buildLearningRequest(req: DraftRequest): DraftRequest {
  if (req.messages.length !== 1 || req.messages[0].role !== "user") {
    throw new ApiError(
      400,
      "invalid_request",
      "Voice learning takes exactly one user message of samples.",
    );
  }
  const content = req.messages[0].content;
  if (content.length > LEARNING_MAX_INPUT_CHARS) {
    throw new ApiError(413, "request_too_large", "The request is too large to learn from.");
  }
  return {
    model: req.model,
    system: LEARNING_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    maxTokens: LEARNING_MAX_TOKENS,
    temperature: LEARNING_TEMPERATURE,
    purpose: "voice_learning",
  };
}
