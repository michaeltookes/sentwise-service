// Browser landing pages for the OAuth / key-provisioning round-trips (item 59).
//
// Clerk (Google sign-in) and OpenRouter redirect the user's browser back to us
// over HTTPS; this page shows a clear "you're done" screen and forwards the
// result to the Mac app's `sentwise://` scheme. Redirecting the browser straight
// to the custom scheme leaves the tab spinning forever (no document to render).
//
// The callback parameter is read CLIENT-SIDE from both the query string and the
// URL fragment: Clerk returns `rotating_token_nonce` in the fragment on an HTTPS
// redirect, and a fragment never reaches the server. So the server just renders
// a static, self-contained page; the browser extracts the value and forwards it.
// Nothing is stored or logged, and only the allow-listed parameter is forwarded.

import { ApiError } from "./errors";

const APP_SCHEME = "sentwise";

interface CallbackRoute {
  /** Host of the `sentwise://<host>` deep link the page forwards to. */
  host: string;
  /** The single query/fragment parameter to forward (everything else dropped). */
  param: string;
  title: string;
  heading: string;
}

const ROUTES: Record<string, CallbackRoute> = {
  "/auth/callback": {
    host: "oauth-callback",
    param: "rotating_token_nonce",
    title: "Signed in to Sentwise",
    heading: "You're all set",
  },
  "/openrouter/callback": {
    host: "openrouter-callback",
    param: "code",
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

// route.host / route.param are compile-time constants (never user input), so
// embedding them in the script is safe; the runtime value from the URL is only
// ever handled inside the browser via encodeURIComponent.
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
  .fail h1, .ok-only { }
</style>
</head>
<body>
<main class="card" id="card">
  <div class="badge" id="badge">
    <svg viewBox="0 0 24 24" fill="none" stroke="${escapeAttr("#1f9d57")}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
  </div>
  <h1 id="heading">${route.heading}</h1>
  <p class="sub" id="sub">Returning you to Sentwise&hellip;</p>
  <p class="hint" id="hint">You can close this tab.</p>
  <a class="btn" id="btn" href="#">Open Sentwise</a>
</main>
<script>
(function () {
  var HOST = ${JSON.stringify(route.host)};
  var PARAM = ${JSON.stringify(route.param)};
  function read(src) { try { return new URLSearchParams(src); } catch (e) { return new URLSearchParams(); } }
  var q = read(location.search.replace(/^\\?/, ""));
  var h = read(location.hash.replace(/^#/, ""));
  var value = q.get(PARAM) || h.get(PARAM);
  if (value) {
    var link = HOST + "?" + PARAM + "=" + encodeURIComponent(value);
    var deep = "${APP_SCHEME}://" + link;
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

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
