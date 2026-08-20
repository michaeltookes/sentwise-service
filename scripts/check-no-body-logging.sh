#!/usr/bin/env bash
# Privacy guard (backlog 56a): fail if any console.* call references a variable
# that could carry user content (request bodies, messages, drafts, prompts).
# This backstops the "nothing logged" claim; run in CI.
set -euo pipefail

# Any console.* usage at all in src/ is suspect — we log nothing by policy.
if grep -rnE 'console\.(log|info|debug|warn|error)' src/ >/dev/null 2>&1; then
  echo "FAIL: console.* found in src/ — this service must not log. Offenders:" >&2
  grep -rnE 'console\.(log|info|debug|warn|error)' src/ >&2
  exit 1
fi
echo "OK: no console.* logging in src/."
