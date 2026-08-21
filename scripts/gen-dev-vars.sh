#!/usr/bin/env bash
# Generate .dev.vars for `wrangler dev` from ~/.config/sentwise-service/.env.
# Never prints secret values. .dev.vars is gitignored.
set -euo pipefail

ENV_FILE="${SENTWISE_SERVICE_ENV:-$HOME/.config/sentwise-service/.env}"
OUT=".dev.vars"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: secrets file not found at $ENV_FILE" >&2
  exit 1
fi

: > "$OUT"
for name in CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY ANTHROPIC_API_KEY; do
  line="$(grep "^${name}=" "$ENV_FILE" || true)"
  if [[ -z "$line" ]]; then
    echo "error: $name missing from $ENV_FILE" >&2
    exit 1
  fi
  printf '%s\n' "$line" >> "$OUT"
done
echo "Wrote $OUT ($(grep -c '=' "$OUT") vars). Values not shown."
