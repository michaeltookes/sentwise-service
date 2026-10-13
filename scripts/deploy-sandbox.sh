#!/usr/bin/env bash
# Deploy the sandbox Worker (sentwise item 123; docs/sandbox-deployment.md).
#
#   npm run deploy:sandbox                      # lint + typecheck + test, then deploy
#   npm run deploy:sandbox -- --dry-run         # build and check only
#   npm run deploy:sandbox -- --secrets-file f  # also upload secrets (CI does this)
#
# Extra arguments are passed to `wrangler deploy --env sandbox`. The deploy is
# refused while any <placeholder> value is left in the sandbox environment of
# wrangler.jsonc (a dry run only warns). CF_ACCOUNT_ID is filled from the
# CLOUDFLARE_ACCOUNT_ID environment variable when it is set; it is only read by
# /admin/margin, so a missing value is a warning, not a failure.
set -euo pipefail
cd "$(dirname "$0")/.."

dry_run=false
for arg in "$@"; do
  [ "$arg" = "--dry-run" ] && dry_run=true
done

# Every `"KEY": "<…>"` line inside the `"sandbox": {` block of wrangler.jsonc.
placeholders=$(awk '
  /"sandbox"[[:space:]]*:[[:space:]]*\{/ { inside = 1 }
  inside && /"[A-Z0-9_]+"[[:space:]]*:[[:space:]]*"<[^"]*>"/ {
    match($0, /"[A-Z0-9_]+"/); print substr($0, RSTART + 1, RLENGTH - 2)
  }
' wrangler.jsonc)

extra=()
if printf '%s\n' "$placeholders" | grep -qx CF_ACCOUNT_ID; then
  placeholders=$(printf '%s\n' "$placeholders" | grep -vx CF_ACCOUNT_ID || true)
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    extra+=(--var "CF_ACCOUNT_ID:${CLOUDFLARE_ACCOUNT_ID}")
  else
    echo "warning: CLOUDFLARE_ACCOUNT_ID is unset; /admin/margin on the sandbox will not work." >&2
  fi
fi

if [ -n "$placeholders" ]; then
  echo "Sandbox values still to fill in wrangler.jsonc (env.sandbox.vars):" >&2
  printf '  %s\n' $placeholders >&2
  if [ "$dry_run" = true ]; then
    echo "warning: continuing because this is a dry run." >&2
  else
    echo "error: refusing to deploy the sandbox with placeholder values." >&2
    exit 1
  fi
fi

exec npx wrangler deploy --env sandbox ${extra[@]+"${extra[@]}"} "$@"
