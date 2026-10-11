# sentwise-service

Cloudflare Worker behind Sentwise: runs model calls for signed-in users and handles accounts, metering, and checkout/licensing (Clerk, Paddle). Deployed with Wrangler.

## Rules
- **Never commit secrets.** Worker secrets live in Wrangler (`wrangler secret`) and `.dev.vars` (gitignored); config files carry variable names only.
- **Never commit directly to `main`.** Branch first. **Exception:** changes only under `docs/` may go to `main`.
- **Never open pull requests** unless asked; push the branch and report. Commit and push only when asked.
- Production deploys are Michael's. Agents may run tests and `wrangler dev`, never `wrangler deploy` to production.

## Backlog
`docs/backlog.md` (create on the first item; numbered items, newest at the bottom of each priority tier). Items that touch the app and the service together are tracked in `michaeltookes/sentwise` and referenced here by number.

## Orchestration

This repo is one lane of the Genkei Labs factory. Priorities across repos, decisions, and the cross-repo ledger live in the private `genkei-ops` repo at `~/Desktop/Current Projects/genkei-ops` (local only).

- Unit of work: a backlog item ID in `docs/backlog.md` (a number; shared app+service items use the sentwise number). Work orders arrive from the orchestrator session (a peer message), from a builder prompt, or from Michael. QA findings from Lucius arrive as backlog items marked "found by".
- Before proposing next steps, read `genkei-ops/docs/inbox.md` and `genkei-ops/docs/backlog.md`; never re-propose work that is done or assigned there.
- When a work order finishes or blocks: append one line to `genkei-ops/docs/inbox.md` (format in that file) and, if a peer session named `genkei-ops…` exists, message it the same line.
- Never open PRs. Push the branch and report; Michael merges.
