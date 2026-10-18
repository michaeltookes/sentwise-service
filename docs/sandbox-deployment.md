# Sandbox deployment

Item 123 (tracked in `michaeltookes/sentwise`). QA proves the trial → checkout → paid path end to
end, every release, without charging a real card. It does that against a **second deployment of
this Worker** that is configured entirely for the Paddle sandbox and a Clerk development instance.
QA builds of the app ("Sentwise QA", see `docs/qa-build.md` in the app repo) point at it.

The production Worker carries no sandbox state. The sandbox deployment is the production code with
different values: no code path checks which deployment it is running in, and
`test/sandbox-config.test.ts` fails if any file under `src/` mentions the sandbox.

Secrets never go in this file. Secret values live in GitHub repository secrets, Wrangler, or the
operator's local `~/.config/sentwise-service/.env`.

## What it is

|                                                | Production                                                                                           | Sandbox                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Worker                                         | `sentwise-inference`                                                                                 | `sentwise-inference-sandbox`                                                   |
| Wrangler config                                | top level of `wrangler.jsonc`                                                                        | `env.sandbox` in `wrangler.jsonc`                                              |
| URL (what the app points at)                   | `https://sentwise-inference.sentwise-service.workers.dev`                                            | `https://sentwise-inference-sandbox.sentwise-service.workers.dev`              |
| Deploy                                         | push to `main` (`deploy.yml`)                                                                        | dispatch **Deploy sandbox** (`deploy-sandbox.yml`) or `npm run deploy:sandbox` |
| Paddle                                         | live (`https://api.paddle.com`, live price ids)                                                      | sandbox (`https://sandbox-api.paddle.com`, sandbox price ids)                  |
| Clerk                                          | production instance (`clerk.sentwise.ai`, `pk_live_…`/`sk_live_…`)                                   | development instance (`pk_test_…`/`sk_test_…`)                                 |
| `APP_CALLBACK_SCHEME`                          | `sentwise`                                                                                           | `sentwise-qa` (the QA build's URL scheme)                                      |
| Usage counters (Durable Object `AccountQuota`) | its own namespace                                                                                    | its own namespace (Durable Objects belong to the Worker)                       |
| Analytics Engine dataset                       | `sentwise_usage`                                                                                     | `sentwise_usage_sandbox` (`USAGE_DATASET_NAME`)                                |
| Secret names                                   | `CLERK_SECRET_KEY`, `ANTHROPIC_API_KEY`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `ADMIN_TOKEN`, … | the same names, sandbox values                                                 |

There is no KV namespace in production, so the sandbox has none either. If one is ever added, the
config test requires the sandbox environment to declare its own.

The `workers.dev` hostname needs no DNS. A custom domain (for example
`sandbox-inference.sentwise.ai`) is optional: add a `routes` entry with `custom_domain: true` under
`env.sandbox` and point the QA build's `SENTWISE_SERVICE_BASE_URL` at it.

## Lockstep rule

The sandbox exists to test the release production is running, so **deploy the same commit to both**.
Production deploys from `main` on every push. After a production deploy (or before a QA run on a
release tag), dispatch **Deploy sandbox** from `main` with `ref` set to that same commit or tag.
The selected commit must be in `main`'s history. A QA run records the tag the sandbox was deployed
from, and a mismatch with the release under test stops the run.

## Deploying

### From GitHub Actions (normal path)

**Actions → Deploy sandbox → Run workflow**, **Use workflow from: main**, `environment: sandbox`,
`ref: <the ref production runs>` (`main`, a release tag, or a commit SHA).

The job requires approval through the existing protected **`production` GitHub environment** because
it uses the same account-level Cloudflare token. That environment must retain its required reviewer
and `main`-only deployment branch policy. This is the approval gate; Wrangler still deploys to the
sandbox Worker. Dispatches from other workflow branches are skipped.

After approval, the job fetches `main` and verifies that the requested ref resolves to a commit in
its history. It checks out that exact SHA before installing dependencies, running repository code,
or making deployment credentials available. Unmerged branch commits and tags pointing to them are
rejected. The job then lints, typechecks, and tests the selected commit, maps the `SANDBOX_`-prefixed
repository secrets to the production secret names, refuses a live Clerk or Paddle key, uploads the
secrets with the deploy (`wrangler deploy --env sandbox --secrets-file`), and smoke-checks `/healthz`, retrying for about 90 seconds (12 attempts, 8 seconds apart) to cover first-deploy `workers.dev` propagation.
The production `deploy.yml` is untouched by this workflow.

Clearing an optional `SANDBOX_` repository secret overwrites its deployed value with an empty string
on the next successful workflow deployment. Clearing `SANDBOX_ADMIN_TOKEN` disables `/admin/*`;
clearing `SANDBOX_CF_ANALYTICS_API_TOKEN` makes the margin dashboard unavailable, and clearing
`SANDBOX_ANALYTICS_HASH_KEY` restores unkeyed user ID hashing. Required secrets must remain nonempty.

### From a terminal

```bash
npm run deploy:sandbox                 # lint + typecheck + test, then wrangler deploy --env sandbox
npm run deploy:sandbox -- --dry-run    # build and check only; never touches Cloudflare
```

`scripts/deploy-sandbox.sh` refuses a real deploy while any `<placeholder>` value is left in
`env.sandbox.vars` (a dry run only warns), and fills `CF_ACCOUNT_ID` from `CLOUDFLARE_ACCOUNT_ID` when
that is set. Secrets set from a terminal go to the sandbox Worker with `--env sandbox`:

```bash
grep '^SANDBOX_PADDLE_API_KEY=' ~/.config/sentwise-service/.env | cut -d= -f2- \
  | npx wrangler secret put PADDLE_API_KEY --env sandbox
```

Run `wrangler secret put` from a real terminal: a piped, non-interactive invocation can upload an
empty secret silently (the 56b gotcha in the README).

## One-time setup

### 1. Paddle sandbox account and catalog

1. Use the Paddle **sandbox** account at `sandbox-vendors.paddle.com`. It is separate from the live
   account; nothing in it can move real money.
2. **Checkout settings → Approved domains:** add `sentwise.ai`. The app loads its checkout page under
   that origin (`PaddleConfig.checkoutOrigin`), so the sandbox needs it approved too.
3. **Developer tools → Authentication:** create
   - an **API key** with `transaction.write`, `transaction.read`, `subscription.read`,
     `subscription.write`, and `customer.read` (the same scopes as the live key), and
   - a **client-side token** (starts with `test_`). It goes into the app's QA build, not the Worker.
4. **Catalog:** one product per tier with one monthly recurring USD price each, mirroring
   `docs/tier-matrix.md` in the app repo:

   | Product            | Price      | Billing |
   | ------------------ | ---------- | ------- |
   | Sentwise Starter   | $9.00 USD  | monthly |
   | Sentwise Pro       | $19.00 USD | monthly |
   | Sentwise Unlimited | $39.00 USD | monthly |

   No trial period on the Paddle prices (the 14-day trial is enforced by the Worker). Copy the three
   `pri_…` ids. A catalog from the 56c era may already exist in the sandbox account; reuse it only
   after checking its names and amounts match the table. A one-time "extra drafts" price is optional;
   set `EXTRA_DRAFTS_PRICE_ID` in `env.sandbox.vars` only if overage purchases are being tested.

5. **Developer tools → Notifications → New destination:**
   - URL: `https://sentwise-inference-sandbox.sentwise-service.workers.dev/v1/paddle/webhook`
   - Events: the same set as the live destination: `subscription.activated`,
     `subscription.created`, `subscription.updated`, `subscription.canceled`,
     `subscription.past_due`, `subscription.paused`, `subscription.resumed`,
     `transaction.completed`, `adjustment.created`, `adjustment.updated`.
   - Copy the destination's secret key (`pdl_ntfset_…`).

### 2. Clerk development instance

The sandbox Worker verifies sessions issued by the Clerk **development** instance, and the QA build
signs in against that instance directly, so QA accounts never exist in production Clerk.

- **Publishable key** (`pk_test_…`): `env.sandbox.vars.CLERK_PUBLISHABLE_KEY` in `wrangler.jsonc`
  (public, committed).
- **Secret key** (`sk_test_…`): repository secret `SANDBOX_CLERK_SECRET_KEY`. The deploy workflow
  refuses anything that does not start with `sk_test_`.
- **Frontend API URL** (`https://<name>.clerk.accounts.dev`): the app's QA build
  (`SENTWISE_CLERK_FRONTEND_API_URL`, see `docs/qa-build.md` in the app repo). The Worker does not
  need it.
- **Email-code sign-in** enabled (the app's primary sign-in), matching the production instance.
- **Redirect allowlist:** add
  `https://sentwise-inference-sandbox.sentwise-service.workers.dev/auth/callback`. That page forwards
  the result to `APP_CALLBACK_SCHEME`, which the sandbox sets to `sentwise-qa`, the scheme only the QA
  build registers, so a production install never receives a QA sign-in and the reverse. If Google
  sign-in is tested on the QA build, enable the Google social connection on the development instance
  too.

### 3. Cloudflare

Nothing to create by hand. The first deploy creates the `sentwise-inference-sandbox` Worker, its
`AccountQuota` Durable Object namespace (the `v1` migration applies to it), and the
`sentwise_usage_sandbox` dataset on first write. The deploy uses the existing `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

### 4. GitHub repository secrets

| Secret                           | Maps to                  | Required | Value                                                                                                                 |
| -------------------------------- | ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `SANDBOX_CLERK_SECRET_KEY`       | `CLERK_SECRET_KEY`       | yes      | Clerk development instance secret key (`sk_test_…`)                                                                   |
| `SANDBOX_ANTHROPIC_API_KEY`      | `ANTHROPIC_API_KEY`      | yes      | An Anthropic key; drafts in QA are real model calls. The production key works; a separate key keeps QA spend visible. |
| `SANDBOX_PADDLE_API_KEY`         | `PADDLE_API_KEY`         | yes      | Paddle sandbox API key (step 1.3)                                                                                     |
| `SANDBOX_PADDLE_WEBHOOK_SECRET`  | `PADDLE_WEBHOOK_SECRET`  | yes      | Paddle sandbox destination secret (`pdl_ntfset_…`, step 1.5)                                                          |
| `SANDBOX_ADMIN_TOKEN`            | `ADMIN_TOKEN`            | for QA   | Admin token for `{sandbox}/admin/*` (trial backdating, comp reads, funnel). Different from production's.              |
| `SANDBOX_CF_ANALYTICS_API_TOKEN` | `CF_ANALYTICS_API_TOKEN` | no       | Only for `/admin/margin` on the sandbox                                                                               |
| `SANDBOX_ANALYTICS_HASH_KEY`     | `ANALYTICS_HASH_KEY`     | no       | Keyed userId hash for analytics                                                                                       |

### 5. Values to fill in `wrangler.jsonc` (`env.sandbox.vars`)

Filled on 2026-10-14 with the values vendor-ops created and verified (Clerk development instance and
the Paddle sandbox catalog). The table records what each one is.

| Variable                    | Value                                                        | What it is                                         |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY`     | `pk_test_cGVhY2VmdWwtZWVsLTk2NjAuY2xlcmsuYWNjb3VudHMuZGV2JA` | Clerk development instance publishable key         |
| `PADDLE_STARTER_PRICE_ID`   | `pri_01m1syd7nfarp8pggpcnvjbgyy`                             | Sandbox Starter price                              |
| `PADDLE_PRO_PRICE_ID`       | `pri_01m1symsxarc4c3jdea0ntb09w`                             | Sandbox Pro price                                  |
| `PADDLE_UNLIMITED_PRICE_ID` | `pri_01m1syrdg05f49kz705gbzn6tz`                             | Sandbox Unlimited price                            |
| `CF_ACCOUNT_ID`             | `<cloudflare-account-id>` (left as is)                       | Filled at deploy time from `CLOUDFLARE_ACCOUNT_ID` |

These are public values (a publishable key and price ids), so they are committed. If one of them is
reset to a `<placeholder>`, `npm run deploy:sandbox` and the workflow refuse to deploy until it is
filled again. `EXTRA_DRAFTS_PRICE_ID` is not set in the sandbox (optional).

## Paddle sandbox test cards

| Card number           | Result                                |
| --------------------- | ------------------------------------- |
| `4242 4242 4242 4242` | succeeds                              |
| `4000 0038 0000 0446` | succeeds after a 3-D Secure challenge |
| `4000 0000 0000 0002` | declined                              |

Any future expiry date, any 3-digit CVC, any cardholder name. Paddle owns the list; check its current
"test cards" page if one of these stops working.

## Cleaning up after a QA run

A sandbox purchase needs no refund. Cancel the sandbox subscription in the sandbox dashboard (or let
TC-M3-08's scheduled cancel run), and delete the QA account from the Clerk development instance.
Production is never involved.
