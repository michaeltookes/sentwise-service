#!/usr/bin/env bash
# Exercise the workflow's actual ref guard against a disposable Git history.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

# Extract the inline guard so these tests also cover its workflow wiring.
awk '
  /^      - name: Verify and check out deployment ref$/ { step = 1; next }
  step && /^      - / { exit }
  step && /^        run: \|$/ { script = 1; next }
  script { sub(/^          /, ""); print }
' "$repo_root/.github/workflows/deploy-sandbox.yml" > "$test_dir/verify-ref.sh"
test -s "$test_dir/verify-ref.sh"

git init --quiet --initial-branch=main "$test_dir/repo"
cd "$test_dir/repo"
git config user.name "Sandbox ref test"
git config user.email "sandbox-ref-test@example.invalid"
git config commit.gpgsign false
git config tag.gpgsign false
git -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "Released commit"
released_sha=$(git rev-parse HEAD)
git tag release
git tag -a annotated-release -m "Annotated release"
git -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "Main update"
main_sha=$(git rev-parse HEAD)
git checkout --quiet -b unmerged
git -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "Unreviewed code"
unmerged_sha=$(git rev-parse HEAD)
git tag unmerged-release
git checkout --quiet --detach "$main_sha"

check_ref() {
  local ref="$1" expected_sha="$2"
  git checkout --quiet --detach "$main_sha"
  if DEPLOY_REF="$ref" bash -e -o pipefail "$test_dir/verify-ref.sh" > "$test_dir/result" 2>&1; then
    if [ -z "$expected_sha" ] || [ "$(git rev-parse HEAD)" != "$expected_sha" ]; then
      echo "FAIL: unexpected checkout for ref: $ref" >&2
      cat "$test_dir/result" >&2
      exit 1
    fi
  elif [ -n "$expected_sha" ] || [ "$(git rev-parse HEAD)" != "$main_sha" ]; then
    echo "FAIL: ref guard rejected a valid ref or changed HEAD on rejection: $ref" >&2
    cat "$test_dir/result" >&2
    exit 1
  fi
}

check_ref main "$main_sha"
check_ref "$released_sha" "$released_sha"
check_ref release "$released_sha"
check_ref refs/tags/release "$released_sha"
check_ref annotated-release "$released_sha"
check_ref unmerged ""
check_ref "$unmerged_sha" ""
check_ref unmerged-release ""
check_ref missing-ref ""
check_ref --help ""
# shellcheck disable=SC2016 # Pass literal shell syntax as untrusted ref input.
check_ref '$(touch injected)' ""
test ! -e injected

echo "OK: sandbox ref guard accepts main history and rejects unmerged or invalid refs."
