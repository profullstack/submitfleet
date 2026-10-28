// Forward-only migrations. Never edit an applied migration; add a new one.
import { schemaSql } from '@profullstack/webhooks';

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  canonical_key TEXT NOT NULL,
  url TEXT NOT NULL,
  name TEXT,
  tagline TEXT,
  description TEXT,
  categories_json TEXT NOT NULL DEFAULT '[]',
  contact_email TEXT,
  logo_path TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  destination_fields_json TEXT NOT NULL DEFAULT '{}',
  approved_at TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, canonical_key)
);

CREATE TABLE destinations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  listing_group TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('launch', 'directory', 'social', 'newsletter', 'press', 'backlink', 'other')),
  categories_json TEXT NOT NULL DEFAULT '[]',
  submission_url TEXT,
  required_fields_json TEXT NOT NULL DEFAULT '[]',
  account_requirement TEXT NOT NULL DEFAULT 'unknown',
  fee_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (fee_status IN ('unknown', 'source_labeled_free', 'verified_free', 'conditional_free', 'paid')),
  fee_conditions TEXT,
  fee_evidence_url TEXT,
  fee_checked_at TEXT,
  automation_method TEXT NOT NULL DEFAULT 'none' CHECK (automation_method IN ('api', 'browser', 'assisted', 'none')),
  automation_permission TEXT NOT NULL DEFAULT 'unknown' CHECK (automation_permission IN ('unknown', 'permitted', 'denied')),
  permission_evidence TEXT,
  permission_checked_at TEXT,
  challenge_policy TEXT NOT NULL DEFAULT 'unknown' CHECK (challenge_policy IN ('unknown', 'none', 'occasional', 'always')),
  backlink_required INTEGER NOT NULL DEFAULT 0,
  quality_decision TEXT NOT NULL DEFAULT 'unreviewed' CHECK (quality_decision IN ('unreviewed', 'accepted', 'rejected')),
  quality_basis TEXT,
  adapter_id TEXT,
  adapter_version TEXT,
  adapter_health TEXT NOT NULL DEFAULT 'unknown' CHECK (adapter_health IN ('unknown', 'healthy', 'quarantined', 'broken')),
  health_reason TEXT,
  contract_tested_at TEXT,
  live_tested_at TEXT,
  live_evidence_ref TEXT,
  reconcile_support TEXT NOT NULL DEFAULT 'none' CHECK (reconcile_support IN ('tested', 'limited', 'none')),
  reconcile_limitation TEXT,
  queue_limit_per_account INTEGER,
  queue_window_hours INTEGER,
  cooldown_hours INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  source_license TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'connected', 'needs_reauth', 'disconnected')),
  sealed_secret TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'coverage_insufficient', 'awaiting_approval', 'approved', 'running', 'paused', 'canceled', 'completed')),
  min_executable INTEGER NOT NULL,
  release_scope TEXT NOT NULL DEFAULT 'initial',
  policy_json TEXT NOT NULL,
  spend_limit_cents INTEGER NOT NULL DEFAULT 0,
  earliest_date TEXT,
  latest_date TEXT,
  executable_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE campaign_targets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  account_id TEXT REFERENCES accounts(id),
  executable INTEGER NOT NULL,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT,
  payload_hash TEXT,
  UNIQUE (campaign_id, destination_id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  scope_hash TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'invalidated', 'rejected')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  account_id TEXT REFERENCES accounts(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  dedupe_key TEXT NOT NULL,
  dedupe_active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  reason_code TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  external_action_performed INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT,
  remote_refs_json TEXT NOT NULL DEFAULT '{}',
  receipt_id TEXT,
  listing_url TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT,
  published_at TEXT,
  removed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX intents_dedupe_active ON intents (dedupe_key) WHERE dedupe_active = 1;
CREATE INDEX intents_state ON intents (state, workspace_id);

CREATE TABLE intent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  fence INTEGER,
  from_state TEXT,
  to_state TEXT,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TRIGGER intent_events_immutable_update BEFORE UPDATE ON intent_events
BEGIN SELECT RAISE(ABORT, 'intent_events is append-only'); END;

CREATE TRIGGER intent_events_immutable_delete BEFORE DELETE ON intent_events
BEGIN SELECT RAISE(ABORT, 'intent_events is append-only'); END;

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL UNIQUE REFERENCES campaigns(id),
  limit_cents INTEGER NOT NULL,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  CHECK (reserved_cents >= 0 AND spent_cents >= 0 AND reserved_cents + spent_cents <= limit_cents)
);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id),
  intent_id TEXT NOT NULL REFERENCES intents(id),
  amount_cents INTEGER NOT NULL,
  actual_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  created_at TEXT NOT NULL
);

CREATE TABLE effort_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT REFERENCES campaigns(id),
  activity TEXT NOT NULL,
  minutes REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE outcomes (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(id),
  observed_at TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  source TEXT NOT NULL,
  note TEXT
)
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE destinations ADD COLUMN channel TEXT;
ALTER TABLE destinations ADD COLUMN description TEXT;
ALTER TABLE destinations ADD COLUMN audience TEXT;
ALTER TABLE destinations ADD COLUMN eligibility TEXT;
ALTER TABLE destinations ADD COLUMN link_type TEXT;
ALTER TABLE destinations ADD COLUMN domain_rating INTEGER;
ALTER TABLE destinations ADD COLUMN monthly_traffic INTEGER;
ALTER TABLE destinations ADD COLUMN website_url TEXT;
ALTER TABLE destinations ADD COLUMN logo_url TEXT;
CREATE INDEX destinations_channel ON destinations (channel, archived);

ALTER TABLE campaigns ADD COLUMN mode TEXT NOT NULL DEFAULT 'all';
ALTER TABLE campaigns ADD COLUMN channels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE campaigns ADD COLUMN include_unknown_pricing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_targets ADD COLUMN mode TEXT;
ALTER TABLE intents ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE intents ADD COLUMN note TEXT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT,
  email_verified_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  name TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX email_tokens_email ON email_tokens (email, created_at);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE oauth_refresh (
  token_hash TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  client_id TEXT NOT NULL,
  access_key_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX oauth_refresh_family ON oauth_refresh (family);

ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN last_used_at TEXT;
ALTER TABLE products ADD COLUMN logo_mime TEXT
`,
  },
  {
    // Signup profile (@profullstack/profile): `profile schema --dialect sqlite --key user_id --key-type text`,
    // then a one-time backfill of every user's email and their name split on the first space.
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS "user_profiles" (
  "user_id" text primary key,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS "user_profiles_email" ON "user_profiles" (lower("email"));
CREATE INDEX IF NOT EXISTS "user_profiles_company_domain" ON "user_profiles" ("company_domain");
INSERT INTO user_profiles (user_id, email, first_name, last_name)
SELECT id, lower(email),
  NULLIF(CASE WHEN instr(trim(COALESCE(name, '')), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1) ELSE trim(COALESCE(name, '')) END, ''),
  NULLIF(CASE WHEN instr(trim(COALESCE(name, '')), ' ') > 0 THEN trim(substr(trim(name), instr(trim(name), ' ') + 1)) END, '')
FROM users WHERE true
ON CONFLICT (user_id) DO UPDATE SET
  email = COALESCE(user_profiles.email, excluded.email),
  first_name = COALESCE(user_profiles.first_name, excluded.first_name),
  last_name = COALESCE(user_profiles.last_name, excluded.last_name)
`,
  },
  {
    // Plan + credit codes + invites. users.pro_until is the plan; plan_grants makes every
    // grant idempotent on (user, source). The credit_* / aff_* module tables are created by
    // @profullstack/redeem-credits and @profullstack/affiliates on first use.
    version: 4,
    sql: `
ALTER TABLE users ADD COLUMN pro_until TEXT;

CREATE TABLE plan_grants (
  user_id TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  days INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, source)
);

CREATE TABLE invite_origins (
  invite_id TEXT PRIMARY KEY,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE invite_acceptances (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  inviter_id TEXT NOT NULL REFERENCES users(id),
  invite_id TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'denied')),
  reason TEXT NOT NULL DEFAULT '',
  bonus_days INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX invite_acceptances_inviter ON invite_acceptances (inviter_id, status, settled_at)
`,
  },
  {
    // Customer webhooks: @profullstack/webhooks' own endpoint + delivery (outbox) tables.
    // Owner = the workspace. Read and written by src/webhook-store.ts on this libSQL client.
    version: 5,
    sql: schemaSql('sqlite').join(';\n'),
  },
  {
    // Unlock-on-use (2026-10-28): each workspace's key vault record. Account
    // secrets are sealed to it ("v2." in accounts.sealed_secret); nothing here
    // opens without the owner's passphrase or recovery key.
    version: 6,
    sql: `CREATE TABLE workspace_vaults (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  seal TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  },
];
