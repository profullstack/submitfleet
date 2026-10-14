import { all, one, run, type Db } from './db.js';
import { newId, nowIso, parseJson, SubmitFleetError } from './util.js';

export const RELEASE_MINIMUM = 100;
/** Proposed: coverage counts only evidence checked within this many days. */
export const COVERAGE_EVIDENCE_MAX_AGE_DAYS = 30;
/** Proposed: volatile fee/policy claims must be refreshed this recently before a write. */
export const WRITE_EVIDENCE_MAX_AGE_HOURS = 24;

const COUNTED_KINDS = new Set(['launch', 'directory']);

export interface Destination {
  id: string;
  slug: string;
  name: string;
  canonical_domain: string;
  aliases: string[];
  listing_group: string;
  kind: string;
  categories: string[];
  submission_url: string | null;
  required_fields: string[];
  account_requirement: string;
  fee_status: string;
  fee_conditions: string | null;
  fee_evidence_url: string | null;
  fee_checked_at: string | null;
  automation_method: string;
  automation_permission: string;
  permission_evidence: string | null;
  permission_checked_at: string | null;
  challenge_policy: string;
  backlink_required: boolean;
  quality_decision: string;
  quality_basis: string | null;
  adapter_id: string | null;
  adapter_version: string | null;
  adapter_health: string;
  health_reason: string | null;
  contract_tested_at: string | null;
  live_tested_at: string | null;
  live_evidence_ref: string | null;
  reconcile_support: string;
  reconcile_limitation: string | null;
  queue_limit_per_account: number | null;
  queue_window_hours: number | null;
  cooldown_hours: number | null;
  disabled: boolean;
  source: string | null;
  source_license: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

type Row = Record<string, unknown>;

export function rowToDestination(r: Row): Destination {
  return {
    ...(r as unknown as Destination),
    aliases: parseJson(r.aliases_json, []),
    categories: parseJson(r.categories_json, []),
    required_fields: parseJson(r.required_fields_json, []),
    backlink_required: Number(r.backlink_required) === 1,
    disabled: Number(r.disabled) === 1,
    archived: Number(r.archived) === 1,
    queue_limit_per_account: r.queue_limit_per_account == null ? null : Number(r.queue_limit_per_account),
    queue_window_hours: r.queue_window_hours == null ? null : Number(r.queue_window_hours),
    cooldown_hours: r.cooldown_hours == null ? null : Number(r.cooldown_hours),
  };
}

// Fields an operator may set through a reviewed registry edit.
const REVIEWED_FIELDS = [
  'name', 'canonical_domain', 'aliases', 'listing_group', 'kind', 'categories', 'submission_url',
  'required_fields', 'account_requirement', 'fee_status', 'fee_conditions', 'fee_evidence_url',
  'fee_checked_at', 'automation_method', 'automation_permission', 'permission_evidence',
  'permission_checked_at', 'challenge_policy', 'backlink_required', 'quality_decision', 'quality_basis',
  'adapter_id', 'adapter_version', 'adapter_health', 'health_reason', 'contract_tested_at',
  'live_tested_at', 'live_evidence_ref', 'reconcile_support', 'reconcile_limitation',
  'queue_limit_per_account', 'queue_window_hours', 'cooldown_hours', 'disabled', 'source', 'source_license',
] as const;

// Imports are discovery input only: they may never set anything that enables execution.
const IMPORT_FIELDS = ['name', 'canonical_domain', 'aliases', 'kind', 'categories', 'submission_url', 'source', 'source_license'] as const;

export type DestinationInput = Partial<Pick<Destination, (typeof REVIEWED_FIELDS)[number]>> & {
  slug: string;
  name: string;
  canonical_domain: string;
  kind: string;
};

const JSON_FIELDS: Record<string, string> = {
  aliases: 'aliases_json',
  categories: 'categories_json',
  required_fields: 'required_fields_json',
};

function toColumns(input: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  for (const k of allowed) {
    if (!(k in input) || input[k] === undefined) continue;
    const v = input[k];
    if (JSON_FIELDS[k]) cols[JSON_FIELDS[k]] = JSON.stringify(v ?? []);
    else if (typeof v === 'boolean') cols[k] = v ? 1 : 0;
    else cols[k] = v;
  }
  return cols;
}

export function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

export async function upsertDestination(db: Db, input: DestinationInput, mode: 'reviewed' | 'import'): Promise<Destination> {
  const allowed = mode === 'reviewed' ? REVIEWED_FIELDS : IMPORT_FIELDS;
  const domain = normalizeDomain(input.canonical_domain);
  const cols = toColumns({ ...input, canonical_domain: domain }, allowed);
  const existing = await one<Row>(db, 'SELECT * FROM destinations WHERE slug = ?', input.slug);
  const now = nowIso();
  if (existing) {
    if (mode === 'import') {
      // An import never overwrites reviewed facts on an existing record.
      return rowToDestination(existing);
    }
    const sets = Object.keys(cols);
    if (sets.length) {
      await run(
        db,
        `UPDATE destinations SET ${sets.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE slug = ?`,
        ...sets.map((c) => cols[c]),
        now,
        input.slug,
      );
    }
  } else {
    // Unless reviewed otherwise, a domain is its own independent listing group.
    cols.listing_group ??= domain;
    if (mode === 'import' && cols.kind && !['launch', 'directory', 'social', 'newsletter', 'press', 'backlink', 'other'].includes(String(cols.kind))) {
      cols.kind = 'other';
    }
    const names = ['id', 'slug', ...Object.keys(cols), 'created_at', 'updated_at'];
    await run(
      db,
      `INSERT INTO destinations (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      newId('dst'),
      input.slug,
      ...Object.values(cols),
      now,
      now,
    );
  }
  return (await getDestination(db, input.slug))!;
}

export async function getDestination(db: Db, idOrSlug: string): Promise<Destination | null> {
  const r = await one<Row>(db, 'SELECT * FROM destinations WHERE id = ? OR slug = ?', idOrSlug, idOrSlug);
  return r ? rowToDestination(r) : null;
}

export async function listDestinations(db: Db, opts: { query?: string; includeArchived?: boolean; limit?: number; offset?: number } = {}): Promise<Destination[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeArchived) where.push('archived = 0');
  if (opts.query) {
    where.push('(name LIKE ? OR slug LIKE ? OR canonical_domain LIKE ? OR categories_json LIKE ?)');
    const q = `%${opts.query}%`;
    args.push(q, q, q, q);
  }
  const rows = await all<Row>(
    db,
    `SELECT * FROM destinations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY slug LIMIT ? OFFSET ?`,
    ...args,
    opts.limit ?? 500,
    opts.offset ?? 0,
  );
  return rows.map(rowToDestination);
}

export async function archiveDestination(db: Db, slug: string): Promise<void> {
  const n = await run(db, 'UPDATE destinations SET archived = 1, updated_at = ? WHERE slug = ?', nowIso(), slug);
  if (!n) throw new SubmitFleetError('not_found', `destination ${slug}`);
}

/** Quarantine on policy/fee/form change: live coverage drops immediately. */
export async function setAdapterHealth(db: Db, slug: string, health: 'healthy' | 'quarantined' | 'broken', reason: string): Promise<void> {
  await run(db, 'UPDATE destinations SET adapter_health = ?, health_reason = ?, updated_at = ? WHERE slug = ?', health, reason, nowIso(), slug);
}

// ── Qualification ─────────────────────────────────────────────────────────────

export interface QualificationOptions {
  now?: number;
  evidenceMaxAgeDays?: number;
  /** Adapter ids actually installed in this engine build. */
  installedAdapters: Set<string>;
}

export interface Qualification {
  stages: {
    discovered: boolean;
    source_labeled_free: boolean;
    verified_free: boolean;
    permission_reviewed: boolean;
    live_tested: boolean;
    release_qualifying: boolean;
  };
  blockers: string[];
}

function fresh(iso: string | null, now: number, maxAgeMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t <= maxAgeMs && t <= now + 60_000;
}

export function qualify(d: Destination, opts: QualificationOptions): Qualification {
  const now = opts.now ?? Date.now();
  const maxAge = (opts.evidenceMaxAgeDays ?? COVERAGE_EVIDENCE_MAX_AGE_DAYS) * 86_400_000;
  const blockers: string[] = [];
  const discovered = !d.archived;
  if (!discovered) blockers.push('archived');
  if (!COUNTED_KINDS.has(d.kind)) blockers.push(`kind_not_counted:${d.kind}`);

  const sourceFree = d.fee_status === 'source_labeled_free' || d.fee_status === 'verified_free';
  const verifiedFree = d.fee_status === 'verified_free' && fresh(d.fee_checked_at, now, maxAge) && !!d.fee_evidence_url;
  if (d.fee_status === 'paid') blockers.push('paid_route');
  else if (d.fee_status === 'conditional_free') blockers.push('conditional_free');
  else if (d.fee_status !== 'verified_free') blockers.push('fee_unverified');
  else if (!verifiedFree) blockers.push('fee_evidence_stale');
  if (d.backlink_required) blockers.push('backlink_required');

  const permitted = d.automation_permission === 'permitted' && fresh(d.permission_checked_at, now, maxAge) && !!d.permission_evidence;
  if (d.automation_permission === 'denied') blockers.push('automation_denied');
  else if (d.automation_permission !== 'permitted') blockers.push('automation_permission_unknown');
  else if (!permitted) blockers.push('permission_evidence_stale');

  if (d.automation_method === 'assisted' || d.automation_method === 'none') blockers.push(`not_unattended:${d.automation_method}`);
  if (d.challenge_policy === 'always') blockers.push('always_requires_challenge');
  if (d.challenge_policy === 'unknown') blockers.push('challenge_policy_unknown');

  const adapterInstalled = !!d.adapter_id && opts.installedAdapters.has(d.adapter_id);
  if (!d.adapter_id) blockers.push('no_adapter');
  else if (!adapterInstalled) blockers.push('adapter_not_installed');
  if (!d.contract_tested_at) blockers.push('no_contract_tests');
  const liveTested = !!d.live_tested_at && !!d.live_evidence_ref;
  if (!liveTested) blockers.push('no_live_submission_evidence');
  if (d.reconcile_support === 'none') blockers.push('no_reconcile');
  if (d.reconcile_support === 'limited' && !d.reconcile_limitation) blockers.push('reconcile_limitation_undocumented');
  if (d.adapter_health !== 'healthy') blockers.push(`adapter_${d.adapter_health}`);
  if (d.disabled) blockers.push('disabled');
  if (d.quality_decision !== 'accepted') blockers.push(`quality_${d.quality_decision}`);
  for (const f of ['account_requirement'] as const) if (d[f] === 'unknown') blockers.push(`${f}_unknown`);

  return {
    stages: {
      discovered,
      source_labeled_free: discovered && sourceFree,
      verified_free: discovered && verifiedFree,
      permission_reviewed: discovered && permitted,
      live_tested: discovered && liveTested,
      release_qualifying: blockers.length === 0,
    },
    blockers,
  };
}

export interface EngineCoverage {
  discovered: number;
  source_labeled_free: number;
  verified_free: number;
  permission_reviewed: number;
  live_tested: number;
  /** Distinct independent listing groups, so aliases and mirrors never multiply coverage. */
  release_qualifying: number;
  release_minimum: number;
  status: 'release_ready' | 'below_minimum';
  qualifying: { slug: string; listing_group: string }[];
  blocker_counts: Record<string, number>;
}

export async function engineCoverage(db: Db, opts: QualificationOptions): Promise<EngineCoverage> {
  const ds = await listDestinations(db, { includeArchived: false, limit: 100_000 });
  const groups = {
    discovered: new Set<string>(),
    source_labeled_free: new Set<string>(),
    verified_free: new Set<string>(),
    permission_reviewed: new Set<string>(),
    live_tested: new Set<string>(),
    release_qualifying: new Set<string>(),
  };
  const qualifying: { slug: string; listing_group: string }[] = [];
  const blocker_counts: Record<string, number> = {};
  for (const d of ds) {
    const q = qualify(d, opts);
    for (const [stage, ok] of Object.entries(q.stages)) if (ok) groups[stage as keyof typeof groups].add(d.listing_group);
    if (q.stages.release_qualifying && !qualifying.some((x) => x.listing_group === d.listing_group)) {
      qualifying.push({ slug: d.slug, listing_group: d.listing_group });
    }
    for (const b of q.blockers) blocker_counts[b] = (blocker_counts[b] ?? 0) + 1;
  }
  const n = groups.release_qualifying.size;
  return {
    discovered: groups.discovered.size,
    source_labeled_free: groups.source_labeled_free.size,
    verified_free: groups.verified_free.size,
    permission_reviewed: groups.permission_reviewed.size,
    live_tested: groups.live_tested.size,
    release_qualifying: n,
    release_minimum: RELEASE_MINIMUM,
    status: n >= RELEASE_MINIMUM ? 'release_ready' : 'below_minimum',
    qualifying,
    blocker_counts,
  };
}

// ── Discovery import ─────────────────────────────────────────────────────────

export interface ImportRecord {
  name: string;
  url: string;
  kind?: string;
  categories?: string[];
  labeled_free?: boolean;
}

/**
 * Imports discovery records. A source's "free" label becomes source_labeled_free at
 * most; nothing imported can enable execution. Duplicate domains collapse.
 */
export async function importDiscovery(db: Db, records: ImportRecord[], source: string, license: string): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const r of records) {
    let domain: string;
    try {
      domain = normalizeDomain(new URL(r.url).hostname);
    } catch {
      skipped++;
      continue;
    }
    const slug = domain.replace(/[^a-z0-9]+/g, '-');
    const exists = await one(db, 'SELECT id FROM destinations WHERE slug = ? OR canonical_domain = ?', slug, domain);
    if (exists) {
      skipped++;
      continue;
    }
    await upsertDestination(
      db,
      { slug, name: r.name, canonical_domain: domain, kind: r.kind ?? 'other', categories: r.categories ?? [], submission_url: r.url, source, source_license: license },
      'import',
    );
    if (r.labeled_free) {
      await run(db, "UPDATE destinations SET fee_status = 'source_labeled_free' WHERE slug = ? AND fee_status = 'unknown'", slug);
    }
    created++;
  }
  return { created, skipped };
}
