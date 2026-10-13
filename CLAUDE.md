# sentwise-service

Cloudflare Worker behind Sentwise: runs model calls for signed-in users and handles accounts, metering, and checkout/licensing (Clerk, Paddle). Deployed with Wrangler.

## Rules

- **Never commit secrets.** Worker secret values live in Wrangler (`wrangler secret`) and `.dev.vars` (gitignored); config files may reference secret variable names but must not contain their values. Public configuration values and binding settings may be committed.
- **Never commit directly to `main`.** Branch first. **Exception:** changes only under `docs/` may go to `main`.
- **Never open pull requests** unless asked; push the branch and report. Commit and push only when asked.
- Production deploys are Michael's. Agents may run tests and `wrangler dev`, never `wrangler deploy` to production.

## Backlog

`docs/backlog.md` (create on the first item; numbered items, newest at the bottom of each priority tier). Items that touch the app and the service together are tracked in `michaeltookes/sentwise` and referenced here by number.

## Orchestration

This repo is one lane of the Genkei Labs factory. Priorities across repos, decisions, and the cross-repo ledger live in the private `genkei-ops` repo at `~/Desktop/Current Projects/genkei-ops` (local only).

- Unit of work: a backlog item ID in `docs/backlog.md` (a number; shared app+service items use the sentwise number). Work orders arrive from the orchestrator session (a peer message), from a builder prompt, or from Michael. QA findings from Lucius arrive as backlog items marked "found by".
- Before proposing next steps, read `genkei-ops/docs/inbox.md` and `genkei-ops/docs/backlog.md` **when that repo is available on this machine** (Michael's MacBook, path above); never re-propose work that is done or assigned there. In a GitHub-hosted or other session without it, say so and propose from this repo's `docs/backlog.md` only.
- When a work order finishes or blocks: **if the ledger is available**, append one line to `genkei-ops/docs/inbox.md` (format in that file) and, if a peer session named `genkei-ops…` exists, message it the same line. **Otherwise** report the same one line in the PR or issue comment you are responding in, and the orchestrator files it.
- Never open PRs unless asked. Commit and push only when asked, then report; Michael merges.
