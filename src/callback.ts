// Browser landing pages for the OAuth / key-provisioning round-trips (item 59).
//
// Clerk (Google sign-in) and OpenRouter redirect the user's browser back to us
// over HTTPS; this page shows a clear "you're done" message and forwards the
// callback parameters to the Mac app's custom URL scheme. Redirecting the
// browser straight to `sentwise://…` leaves the previous page spinning forever,
// because the tab never receives a document to render.
//
// PRIVACY: only the allow-listed parameters are forwarded, nothing is stored or
// logged, and the values are HTML/JS-escaped before being embedded.

import { ApiError } from "./errors";

const APP_SCHEME = "sentwise";

interface CallbackRoute {
  /** Host part of the `sentwise://<host>` deep link. */
  host: string;
  /** Query parameters forwarded verbatim (everything else is dropped). */
  params: readonly string[];
  title: string;
  heading: string;
}

const ROUTES: Record<string, CallbackRoute> = {
  "/auth/callback": {
    host: "oauth-callback",
    params: ["rotating_token_nonce"],
    title: "Signed in to Sentwise",
    heading: "You're signed in",
  },
  "/openrouter/callback": {
    host: "openrouter-callback",
    params: ["code"],
    title: "OpenRouter connected",
    heading: "OpenRouter is connected",
  },
};

export function isCallbackPath(pathname: string): boolean {
  return Object.hasOwn(ROUTES, pathname);
}

/** Build the `sentwise://` deep link for a callback path, or null if a required param is missing. */
export function buildAppDeepLink(pathname: string, search: URLSearchParams): string | null {
  const route = ROUTES[pathname];
  if (!route) return null;
  const forwarded = new URLSearchParams();
  for (const name of route.params) {
    const value = search.get(name);
    if (!value) return null;
    forwarded.set(name, value);
  }
  return `${APP_SCHEME}://${route.host}?${forwarded.toString()}`;
}

export function renderCallbackPage(pathname: string, search: URLSearchParams): Response {
  const route = ROUTES[pathname];
  if (!route) throw new ApiError(404, "not_found", "Not found.");
  const deepLink = buildAppDeepLink(pathname, search);
  if (!deepLink) {
    throw new ApiError(
      400,
      "invalid_request",
      "The sign-in response was missing required details.",
    );
  }
  const html = page(route, deepLink);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(route: CallbackRoute, deepLink: string): string {
  const href = escapeHtml(deepLink);
  // JSON.stringify gives a JS string literal; escape "<" so "</script>" can't break out.
  const jsHref = JSON.stringify(deepLink).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(route.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; opacity: .8; }
  a.button { display: inline-block; margin-top: 1.25rem; padding: .6rem 1.2rem; border-radius: .6rem;
             background: #2f6fed; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(route.heading)}</h1>
  <p>Returning you to Sentwise&hellip; You can close this tab.</p>
  <p><a class="button" href="${href}">Open Sentwise</a></p>
  <p><small>If nothing happens, click the button above.</small></p>
</main>
<script>location.replace(${jsHref});</script>
</body>
</html>
`;
}
