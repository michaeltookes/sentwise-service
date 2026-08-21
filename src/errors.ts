// Structured JSON errors. The app maps these to plain, user-facing messages —
// no raw HTTP status text ever reaches the user.

export interface ErrorExtra {
  [key: string]: unknown;
}

export function jsonError(
  status: number,
  type: string,
  message: string,
  extra: ErrorExtra = {},
): Response {
  return new Response(JSON.stringify({ error: { type, message, ...extra } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Thrown anywhere in a handler to short-circuit with a structured error body. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public extra: ErrorExtra = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  toResponse(): Response {
    return jsonError(this.status, this.type, this.message, this.extra);
  }
}
