// Browser landing pages for the OAuth / key-provisioning round-trips
// (items 59 + 89).
//
// Clerk (Google sign-in) and OpenRouter redirect the user's browser back to us
// over HTTPS; this page shows a clear "you're done" screen and forwards the
// result to the Mac app's `sentwise://` scheme. Redirecting the browser straight
// to the custom scheme leaves the tab spinning forever (no document to render).
//
// The callback params are read CLIENT-SIDE from both the query string and the
// URL fragment: Clerk returns `rotating_token_nonce` in the fragment on an HTTPS
// redirect, and a fragment never reaches the server. So the server just renders
// a static, self-contained page; the browser extracts the values and forwards
// them. Nothing is stored or logged, and ONLY the allow-listed params are
// forwarded — every other query/fragment key is ignored, and the values are
// URL-encoded (never interpolated into HTML/JS) so they cannot inject.

import { ApiError } from "./errors";

const APP_SCHEME = "sentwise";

interface CallbackRoute {
  /** Host of the `sentwise://<host>` deep link the page forwards to. */
  host: string;
  /**
   * The allow-list of query/fragment params to forward, in output order.
   * `params[0]` is REQUIRED — if it is absent the page shows a failure state and
   * forwards nothing. The rest (e.g. `state`) are forwarded only when present.
   * Every param NOT in this list is dropped.
   */
  params: readonly [string, ...string[]];
  title: string;
  heading: string;
}

const ROUTES: Record<string, CallbackRoute> = {
  "/auth/callback": {
    host: "oauth-callback",
    params: ["rotating_token_nonce", "state"],
    title: "Signed in to Sentwise",
    heading: "You're all set",
  },
  "/openrouter/callback": {
    host: "openrouter-callback",
    params: ["code", "state"],
    title: "OpenRouter connected",
    heading: "OpenRouter connected",
  },
};

export function isCallbackPath(pathname: string): boolean {
  return Object.hasOwn(ROUTES, pathname);
}

export function renderCallbackPage(pathname: string): Response {
  const route = ROUTES[pathname];
  if (!route) throw new ApiError(404, "not_found", "Not found.");
  return new Response(page(route), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

// route.host / route.params are compile-time constants (never user input), and
// they are embedded via JSON.stringify so they are valid JS literals. The
// runtime values from the URL are NEVER interpolated into the page — they are
// read in the browser and only ever placed into a URLSearchParams (which
// percent-encodes them) or assigned via textContent, so they cannot inject into
// the HTML or the script.
function page(route: CallbackRoute): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${route.title}</title>
<style>
  :root { color-scheme: light dark; --fg:#0b0c0f; --muted:#5b6472; --bg:#f6f7f9; --card:#fff; --brand:#2f6fed; --ok:#1f9d57; --border:#e6e8ec; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f3f4f6; --muted:#9aa4b2; --bg:#0c0e12; --card:#14171d; --brand:#5b8dff; --ok:#3fbf77; --border:#232833; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:1.5rem;
         background:var(--bg); color:var(--fg);
         font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { width:100%; max-width:30rem; background:var(--card); border:1px solid var(--border);
          border-radius:16px; padding:2.75rem 2.25rem; text-align:center;
          box-shadow:0 1px 3px rgba(0,0,0,.06),0 8px 30px rgba(0,0,0,.06); }
  .badge { width:64px; height:64px; margin:0 auto 1.25rem; border-radius:50%;
           display:grid; place-items:center; background:color-mix(in srgb,var(--ok) 15%,transparent); }
  .badge svg { width:34px; height:34px; }
  h1 { font-size:1.6rem; font-weight:650; margin:0 0 .5rem; letter-spacing:-.01em; }
  p { margin:.35rem 0; color:var(--muted); }
  .sub { font-size:1.02rem; }
  .hint { font-size:.85rem; margin-top:1.25rem; }
  .btn { display:none; margin-top:1.5rem; padding:.7rem 1.4rem; border-radius:10px;
         background:var(--brand); color:#fff; text-decoration:none; font-weight:600; }
  .fail .badge { background:color-mix(in srgb,#d64545 15%,transparent); }
</style>
</head>
<body>
<main class="card" id="card">
  <div class="badge" id="badge">
    <svg viewBox="0 0 24 24" fill="none" stroke="#1f9d57" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
  </div>
  <h1 id="heading">${route.heading}</h1>
  <p class="sub" id="sub">Returning you to Sentwise&hellip;</p>
  <p class="hint" id="hint">You can close this tab.</p>
  <a class="btn" id="btn" href="#">Open Sentwise</a>
</main>
<script>
(function () {
  var HOST = ${JSON.stringify(route.host)};
  // Allow-list of params to forward, in output order; PARAMS[0] is required.
  var PARAMS = ${JSON.stringify(route.params)};
  function read(src) { try { return new URLSearchParams(src); } catch (e) { return new URLSearchParams(); } }
  var q = read(location.search.replace(/^\\?/, ""));
  var h = read(location.hash.replace(/^#/, ""));
  // Clerk returns the value in the fragment on HTTPS; prefer the query, fall back
  // to the fragment. Only the allow-listed names are ever read.
  function pick(name) {
    var v = q.get(name);
    if (v === null || v === "") v = h.get(name);
    return (v === null || v === "") ? null : v;
  }
  var primary = pick(PARAMS[0]);
  if (primary) {
    var out = new URLSearchParams();
    for (var i = 0; i < PARAMS.length; i++) {
      var v = pick(PARAMS[i]);
      if (v !== null) out.set(PARAMS[i], v);
    }
    var deep = "${APP_SCHEME}://" + HOST + "?" + out.toString();
    var btn = document.getElementById("btn");
    btn.href = deep; btn.style.display = "inline-block";
    location.replace(deep);
  } else {
    document.getElementById("card").className = "card fail";
    document.getElementById("badge").innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="#d64545" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    document.getElementById("heading").textContent = "Couldn't finish sign-in";
    document.getElementById("sub").textContent = "The response didn't include what we needed. Return to Sentwise and try again.";
    document.getElementById("hint").textContent = "You can close this tab.";
  }
})();
</script>
</body>
</html>
`;
}
