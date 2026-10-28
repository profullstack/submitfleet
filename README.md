# SubmitFleet

One product profile. Coordinated submissions. Proof of what went live.

SubmitFleet is an open-source, self-hostable engine for submitting legitimate products to launch
sites and directories. It keeps one approved product profile, plans a bounded campaign, asks the
owner to approve exactly what will be sent, runs durable workers, and records receipts and verified
listings. The same core serves a CLI, a TUI, an HTTP API, an MCP server and a mobile dashboard.

## Status

Live at https://submitfleet.com.

- **Accounts:** sign up with a passkey, email + password, or an emailed link. Each account gets its own
  workspace. `submitfleet login` signs the CLI in through the browser (OAuth 2.1 + PKCE).
- **Catalog:** 339 launch sites and directories (the CC0 awesome-submitlist catalog), 203 free to list,
  with price, eligibility, audience, link type and traffic for each.
- **Assisted submissions:** for every destination SubmitFleet prepares each form field from your approved
  product facts, links the submit page and tracks submitted, live (with the listing URL), rejected or skipped.
  Destinations are ranked by fit, and niche or platform-only directories that do not match your product are
  left unchecked.
- **Automatic submissions:** only where a destination's API permits it and an adapter has been proven
  against it. Today that is **0 of 339** (`submitfleet coverage report`); the TinyLaunch adapter is
  contract-tested but has not made a live submission yet.

## What the engine enforces

- **The release gate.** A destination counts only if it is a launch site or directory, verified free
  with fresh evidence, permission-reviewed, unattended (not assisted, not always-captcha), has an
  installed adapter with contract tests, owner-authorized live-submission evidence, reconciliation
  (or a documented limitation), healthy status and an accepted quality review. Counts are of
  independent listing groups, so aliases, mirrors and language paths never multiply coverage.
  Imports from public lists are discovery input only and can never enable execution.
- **Strict campaigns.** `--min-executable-destinations` defaults to 100. A campaign with fewer
  executable targets returns `coverage_insufficient` with the real count and every blocker, and
  cannot be approved or run. The owner may plan a smaller campaign explicitly; the engine gate is
  unchanged.
- **Approvals bound to scope.** The owner approves a hash of the exact targets, accounts, payloads,
  product facts, dates and spend limits. Any material change invalidates it. Agents (and the MCP
  server) can request approval but there is no agent path to grant it; the CLI only approves from
  an interactive terminal.
- **Free only by default.** Listing spend is fixed at $0. Paid, conditional-free and
  backlink-required routes are excluded. An adapter that meets an unexpected payment stops for a
  human.
- **Durable, honest execution.** Intents are persisted before any external write. Workers claim
  atomically with leases and fencing; per-account queue limits and cooldowns are enforced inside the
  claim. A timeout after a possible write is `uncertain` and is reconciled before anything is
  retried. Submitted, scheduled, under review and published are separate states. The event history
  is append-only.
- **Bounded spend.** Operating costs are reserved atomically before dispatch and settled after, so
  parallel workers cannot overspend.
- **Stops.** Global pause, campaign pause, account disconnect and destination disable all stop new
  writes. Cancel stops unsent work and never claims remote deletion.
- **Secrets.** Account credentials are sealed with AES-256-GCM and never appear in model context,
  reports or logs. Workspaces are isolated.
- **Reports.** Original target set, exclusions, receipts, listing URLs, unresolved jobs, effort and
  itemized cost, in Markdown, JSON or CSV. Missing analytics or effort stay unknown, never zero.

## Quick start (self-hosted)

```sh
pnpm install && pnpm build
node dist/cli.js init                 # workspace, secret key, owner API key (shown once)
node dist/cli.js catalog seed
node dist/cli.js coverage report      # exit 3 while below 100
node dist/cli.js products add https://your-product.example --name "Name" --tagline "..." \
  --description "..." --logo logo.png --field tinylaunch.category_id=9
node dist/cli.js products approve PRODUCT_ID
node dist/cli.js accounts connect tinylaunch --email you@example.com
node dist/cli.js campaign plan --product PRODUCT_ID --free-only --min-executable-destinations 100
node dist/cli.js campaign preview CAMPAIGN_ID
node dist/cli.js campaign approve CAMPAIGN_ID
node dist/cli.js campaign run CAMPAIGN_ID
node dist/cli.js worker               # or: serve (API + dashboard + worker)
node dist/cli.js report export CAMPAIGN_ID --format markdown
```

Assets (logos) are read only from `$SUBMITFLEET_HOME/assets`. Run `submitfleet help` for every
command. Exit codes: 0 ok, 1 error, 2 usage, 3 gate not met, 4 jobs waiting for a person.

### Configuration

| Variable | Default |
| --- | --- |
| `SUBMITFLEET_HOME` | `~/.local/share/submitfleet` |
| `SUBMITFLEET_DB_URL` / `SUBMITFLEET_DB_AUTH_TOKEN` | local SQLite file; set a `libsql://` URL for Turso |
| `SUBMITFLEET_SECRET_KEY` | generated key file in `SUBMITFLEET_HOME` (hosted: inject from the vault) |
| `SUBMITFLEET_ASSETS_DIR` | `$SUBMITFLEET_HOME/assets` |
| `PORT`, `HOST` | `8787`, `127.0.0.1` |
| `SUBMITFLEET_ALLOWED_ORIGINS` | none (same-origin only) |

## Surfaces

- **CLI** `submitfleet ...` and **TUI** `submitfleet tui`
- **HTTP API** under `/api/v1` with bearer API keys (`owner` or `agent` role)
- **MCP**: `submitfleet mcp --stdio` locally, or authenticated Streamable HTTP at `/mcp`. All tools
  use the `submitfleet_` prefix.
- **Dashboard** at `/app`: coverage, portfolio, campaigns (preview, approve, run, pause, cancel),
  human-action queue, accounts, reports with Copy Markdown and downloads.

## Webhooks

A workspace owner subscribes HTTPS endpoints to SubmitFleet events (`@profullstack/webhooks`):
Settings > Webhooks, `/api/v1/webhooks` (owner key or session), `submitfleet webhooks ...` or the
`submitfleet_webhook_*` MCP tools. Each delivery is a CloudEvent (`type`, `source`, `subject`,
`time`, `data`) POSTed with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
`webhook-signature`), signed with the endpoint's `whsec_` secret (shown once; rotate any time).
Failed deliveries retry with backoff for about three days; 20 failures in a row switch the endpoint off.

| Event | When |
| --- | --- |
| `campaign.started` / `campaign.resumed` | an approved campaign is run / a paused one runs again |
| `campaign.paused` / `campaign.canceled` | paused / canceled (unsent work dropped) |
| `campaign.completed` | every submission reached a final state (the campaign moves to `completed`) |
| `submission.needs_human` | a submission waits for you (CAPTCHA, account, assisted step) |
| `submission.submitted` | sent to the destination (or marked submitted) |
| `submission.published` / `submission.rejected` | the listing is live / the destination rejected it |
| `submission.failed` / `submission.removed` | skipped or failed / a live listing was taken down |

Endpoints and the outbox live in `webhook_endpoints` / `webhook_deliveries` (migration 5), secrets
sealed with `SUBMITFLEET_SECRET_KEY`. `submitfleet serve` drains the outbox.

## Credit codes and invites

- **Credit codes** (`@profullstack/redeem-credits`) grant Pro days. Redeem under Settings > Plan
  ("Have a code?"), `POST /api/v1/credits/redeem`, `submitfleet redeem CODE` or the
  `submitfleet_redeem_code` MCP tool. Every grant extends `users.pro_until` through one path,
  idempotent on (user, source). Mint on the server: `submitfleet credits mint --days 30 [--max 1]
  [--expires-days 30] [--label L]` (also `credits list`, `credits revoke ID`), run against the
  local database (on the hosted box: `docker exec <app container> node dist/cli.js credits mint ...`).
- **Invites** (`@profullstack/affiliates`): 3 per account at `/invites`, landing at `/i/<code>`.
  The code is remembered on the device and on the emailed sign-in link. A new account (7 days or
  younger) accepts one invite; both people get `SUBMITFLEET_INVITE_BONUS_DAYS` (default 14) Pro
  days, refused for the same mailbox (+tags, Gmail dots), throwaway inboxes, the same network,
  `?ref=` sign-ups and past `SUBMITFLEET_INVITE_MONTHLY_CAP` (default 5) bonuses per inviter per 30 days.
- `?ref=<code>` on any page is first-touch affiliate attribution (cookie `referral_code`).

## Adapters

Every adapter implements `capabilities`, `validate`, `prepare` (no remote writes), `preflight`,
`execute` and `reconcile`; `update` and `withdraw` are optional and otherwise return
`unsupported_operation`. See `src/adapters/types.ts` and the TinyLaunch adapter for the pattern.
An adapter in the code is necessary, never sufficient: a destination counts only after its catalog
record carries contract-test and live-submission evidence through a reviewed registry edit.

## Known gaps against the PRD

- 99+ more qualifying adapters, and the first live TinyLaunch submission.
- The dashboard is plain HTML + JS served by the app rather than Next.js.
- Browser-adapter runtime (isolated profiles, selectors, receipts) is not built.
- Analytics integration: outcomes can be recorded but no provider is connected.

## License

MIT
