#!/usr/bin/env bash
# Privacy guard (backlog 56a/56b): fail if any console.* call appears anywhere in
# src/ — it could carry user content (request bodies, messages, drafts, prompts).
# This backstops the "nothing logged" claim; run in CI. The check is a recursive
# scan of the whole src/ tree, so it automatically covers the 56b metering
# modules (metering.ts, quota-do.ts, quota-client.ts, analytics.ts, admin.ts) —
# none of which may log content either (they handle only counters + hashed ids).
set -euo pipefail

# Any console.* usage at all in src/ is suspect — we log nothing by policy.
if grep -rnE 'console\.(log|info|debug|warn|error)' src/ >/dev/null 2>&1; then
  echo "FAIL: console.* found in src/ — this service must not log. Offenders:" >&2
  grep -rnE 'console\.(log|info|debug|warn|error)' src/ >&2
  exit 1
fi
echo "OK: no console.* logging in src/."
