import {
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  MAX_TOTAL_CONTENT_CHARS,
  type Env,
} from "./config";
import { ApiError } from "./errors";

// Wire shape accepted by POST /v1/draft. Deliberately mirrors the Sentwise
// app's `LLMRequest` value type so the app-side adapter stays thin.
export interface DraftRequest {
  model?: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

// Wire shape returned by POST /v1/draft — mirrors the app's `LLMResponse`.
export interface DraftResponse {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Validate the untrusted request body into a DraftRequest, or throw ApiError(400). */
export function parseDraftRequest(body: unknown): DraftRequest {
  if (typeof body !== "object" || body === null) {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const messages = b.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, "invalid_request", "`messages` must be a non-empty array.");
  }
  const parsed: DraftRequest["messages"] = messages.map((m, i) => {
    if (typeof m !== "object" || m === null) {
      throw new ApiError(400, "invalid_request", `messages[${i}] must be an object.`);
    }
    const mm = m as Record<string, unknown>;
    if (mm.role !== "user" && mm.role !== "assistant") {
      throw new ApiError(400, "invalid_request", `messages[${i}].role must be "user" or "assistant".`);
    }
    if (typeof mm.content !== "string") {
      throw new ApiError(400, "invalid_request", `messages[${i}].content must be a string.`);
    }
    return { role: mm.role, content: mm.content };
  });

  const req: DraftRequest = { messages: parsed };
  // Cost guard (56a): only the server-chosen default model is allowed, and
  // maxTokens is clamped, so a client can't run up spend on a bigger model or a
  // huge completion. TODO(56b): per-account token metering replaces these caps.
  if (b.model !== undefined) {
    if (typeof b.model !== "string") throw new ApiError(400, "invalid_request", "`model` must be a string.");
    if (b.model !== DEFAULT_MODEL) throw new ApiError(400, "invalid_request", "Unsupported model.");
    req.model = b.model;
  }
  if (b.system !== undefined) {
    if (typeof b.system !== "string") throw new ApiError(400, "invalid_request", "`system` must be a string.");
    req.system = b.system;
  }
  if (b.maxTokens !== undefined) {
    if (typeof b.maxTokens !== "number") throw new ApiError(400, "invalid_request", "`maxTokens` must be a number.");
    // Clamp into [1, DEFAULT_MAX_TOKENS] rather than reject, so a generous client
    // value still works but can never exceed the server ceiling.
    req.maxTokens = Math.min(Math.max(Math.floor(b.maxTokens), 1), DEFAULT_MAX_TOKENS);
  }
  if (b.temperature !== undefined) {
    if (typeof b.temperature !== "number") throw new ApiError(400, "invalid_request", "`temperature` must be a number.");
    req.temperature = b.temperature;
  }

  // Bound total input size (system + every message body) to cap upstream cost.
  const totalChars =
    (req.system?.length ?? 0) + req.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    throw new ApiError(413, "request_too_large", "The request is too large to draft.");
  }

  return req;
}

/**
 * Forward a drafting request to the Anthropic Messages API using the
 * server-held key and return the mirrored { text, usage }.
 *
 * NOTE (privacy): this function does not log `req` or the response body. The
 * mail content passes through memory only. See src/config.ts.
 *
 * `fetchImpl` is injectable purely so tests can mock the upstream call.
 */
export async function forwardToAnthropic(
  req: DraftRequest,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<DraftResponse> {
  const payload: Record<string, unknown> = {
    model: req.model ?? DEFAULT_MODEL,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system !== undefined) payload.system = req.system;
  if (req.temperature !== undefined) payload.temperature = req.temperature;

  let res: Response;
  try {
    res = await fetchImpl(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Network failure reaching Anthropic — never leak internals.
    throw new ApiError(502, "upstream_unavailable", "Could not reach the drafting service. Try again shortly.");
  }

  if (!res.ok) {
    throw mapAnthropicError(res.status, await safeErrorType(res));
  }

  let data: AnthropicMessage;
  try {
    data = (await res.json()) as AnthropicMessage;
  } catch {
    throw new ApiError(502, "upstream_invalid_response", "The drafting service returned an unexpected response.");
  }

  const text = (data.content ?? [])
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicMessage {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Read ONLY the Anthropic error `type` string (never the message, which could
 * theoretically echo request content) for mapping/telemetry.
 */
async function safeErrorType(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { type?: string } };
    return body.error?.type ?? "unknown";
  } catch {
    return "unknown";
  }
}

function mapAnthropicError(status: number, upstreamType: string): ApiError {
  // Never forward the upstream message body. Map to clean, user-safe errors.
  if (status === 429 || upstreamType === "rate_limit_error") {
    return new ApiError(429, "rate_limited", "The drafting service is busy. Please try again in a moment.");
  }
  if (status === 529 || upstreamType === "overloaded_error") {
    return new ApiError(503, "overloaded", "The drafting service is temporarily overloaded. Try again shortly.");
  }
  if (status === 400 || upstreamType === "invalid_request_error") {
    return new ApiError(400, "invalid_request", "The drafting request was rejected as malformed.");
  }
  // 401/403 here means OUR server key is bad — that's an internal fault, not the user's.
  return new ApiError(502, "upstream_error", "The drafting service returned an error. Please try again.");
}
