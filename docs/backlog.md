# Backlog

Prioritized list of planned features, fixes, and technical debt for **sentwise-service**, the Cloudflare Worker behind Sentwise (managed inference, accounts, metering, and Paddle checkout/licensing).

> **Item format:** every item has a stable numeric ID, a bold title, a one-line summary, and acceptance criteria. Item numbers are stable IDs: they are never reused or renumbered when items are completed. New items go at the bottom of their priority tier. Items that touch the app and the service together are tracked in `michaeltookes/sentwise` and referenced here by that number. Completed items stay in place marked **Done** with the branch or PR that closed them.

---

## High Priority

_None open._

## Medium Priority

1. **manage-billing reads Clerk metadata uncached** — **Done** (branch `manage-billing-uncached-clerk`)
   `GET /v1/paddle/manage-billing` read the Clerk user through the 30-second S-M1 display cache, so right after a webhook created or replaced a subscription it could return 404 or mint a portal URL for the old subscription. Found by Codex review on PR #37 (P2).
   - ✅ The manage-billing handler reads the Clerk user fresh (`useCache: false`).
   - ✅ `GET /v1/me` still uses the cache.
   - ✅ Test: with a cached record holding the old subscription, manage-billing returns the portal URL for the new one, and a following `/v1/me` makes no extra Clerk lookup.

## Low Priority

_None open._
