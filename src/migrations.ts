// Forward-only migrations. Never edit an applied migration; add a new one.
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
];
