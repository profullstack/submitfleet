import type { Adapter } from './adapters/types.js';
import { createBudget } from './budgets.js';
import { listDestinations, qualify, RELEASE_MINIMUM, type Destination } from './catalog.js';
import { all, one, run, type Db } from './db.js';
import { requireProduct, type Product } from './products.js';
import { appendEvent } from './ledger.js';
import { hashValue, newId, nowIso, parseJson, sha256, SubmitFleetError } from './util.js';
import { requireOwner, usableAccount, type Actor } from './workspaces.js';

export interface CampaignPolicy {
  /** Default and only supported mode today: zero listing spend. */
  free_only: true;
  allow_conditional_free: false;
  allow_account_creation: false;
}

export const DEFAULT_POLICY: CampaignPolicy = { free_only: true, allow_conditional_free: false, allow_account_creation: false };

export interface PlanInput {
  productId: string;
  minExecutableDestinations?: number;
  spendLimitCents?: number;
  earliestDate?: string | null;
  latestDate?: string | null;
  releaseScope?: string;
  /** Restrict to these destination slugs; otherwise every catalog entry is considered. */
  destinations?: string[];
}

export interface TargetPlan {
  destination: string;
  listing_group: string;
  executable: boolean;
  blockers: string[];
  account_id: string | null;
  payload_hash: string | null;
}

export interface Campaign {
  id: string;
  workspace_id: string;
  product_id: string;
  status: string;
  min_executable: number;
  release_scope: string;
  policy: CampaignPolicy;
  spend_limit_cents: number;
  earliest_date: string | null;
  latest_date: string | null;
  executable_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignPlan {
  campaign: Campaign;
  counts: {
    considered: number;
    release_qualifying: number;
    product_eligible: number;
    account_ready: number;
    not_duplicate: number;
    executable: number;
    min_executable: number;
  };
  targets: TargetPlan[];
}

export interface PlanDeps {
  adapters: Map<string, Adapter>;
  readAsset: (path: string) => Promise<Buffer>;
  now?: () => number;
}

function rowToCampaign(r: Record<string, unknown>): Campaign {
  return {
    ...(r as unknown as Campaign),
    policy: parseJson(r.policy_json, DEFAULT_POLICY),
    min_executable: Number(r.min_executable),
    spend_limit_cents: Number(r.spend_limit_cents),
    executable_count: Number(r.executable_count),
  };
}

export async function getCampaign(db: Db, workspaceId: string, id: string): Promise<Campaign> {
  const r = await one<Record<string, unknown>>(db, 'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!r) throw new SubmitFleetError('not_found', `campaign ${id}`);
  return rowToCampaign(r);
}

export async function listCampaigns(db: Db, workspaceId: string, limit = 100, offset = 0): Promise<Campaign[]> {
  const rows = await all<Record<string, unknown>>(db, 'SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', workspaceId, limit, offset);
  return rows.map(rowToCampaign);
}

export function dedupeKey(workspaceId: string, product: Product, d: Destination, releaseScope: string): string {
  // Deliberately excludes the account and the draft wording: a second account or a
  // reworded pitch for the same product at the same listing surface is a duplicate.
  return sha256([workspaceId, product.canonical_key, d.listing_group, releaseScope].join('|'));
}

function productFits(product: Product, d: Destination): boolean {
  if (!d.categories.length) return true;
  const mine = new Set(product.categories.map((c) => c.toLowerCase()));
  return d.categories.some((c) => mine.has(c.toLowerCase()));
}

export function productContentHash(p: Product): string {
  return hashValue({
    url: p.url,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    categories: p.categories,
    contact_email: p.contact_email,
    logo_path: p.logo_path,
    facts: p.facts,
    destination_fields: p.destination_fields,
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Builds (or rebuilds) a campaign plan. Re-planning invalidates any prior approval. */
export async function planCampaign(db: Db, actor: Actor, input: PlanInput, deps: PlanDeps, campaignId?: string): Promise<CampaignPlan> {
  const product = await requireProduct(db, actor.workspaceId, input.productId);
  const min = input.minExecutableDestinations ?? RELEASE_MINIMUM;
  if (!Number.isInteger(min) || min < 1) throw new SubmitFleetError('invalid_request', 'min_executable_destinations must be a positive integer');
  for (const d of [input.earliestDate, input.latestDate]) if (d && !DATE_RE.test(d)) throw new SubmitFleetError('invalid_request', 'dates must be YYYY-MM-DD');
  const releaseScope = input.releaseScope ?? 'initial';
  const now = deps.now?.() ?? Date.now();
  const installed = new Set(deps.adapters.keys());

  let destinations = await listDestinations(db, { limit: 100_000 });
  if (input.destinations?.length) {
    const want = new Set(input.destinations);
    destinations = destinations.filter((d) => want.has(d.slug));
  }

  const counts = { considered: 0, release_qualifying: 0, product_eligible: 0, account_ready: 0, not_duplicate: 0, executable: 0, min_executable: min };
  const seenGroups = new Set<string>();
  const targets: (TargetPlan & { destination_id: string; payload: Record<string, unknown> | null })[] = [];

  for (const d of destinations) {
    counts.considered++;
    const blockers: string[] = [];
    const q = qualify(d, { now, installedAdapters: installed });
    blockers.push(...q.blockers);
    if (q.stages.release_qualifying) counts.release_qualifying++;

    if (seenGroups.has(d.listing_group)) blockers.push('same_listing_group_as_other_target');
    if (!product.approved_at) blockers.push('product_facts_unapproved');
    if (!productFits(product, d)) blockers.push('category_mismatch');
    const adapter = d.adapter_id ? deps.adapters.get(d.adapter_id) : undefined;
    if (adapter) for (const issue of adapter.validate(product, d)) blockers.push(`${issue.code}:${issue.field}`);
    const eligible = blockers.length === 0;
    if (eligible) counts.product_eligible++;

    const account = await usableAccount(db, actor.workspaceId, d.id, now);
    if (!account && d.account_requirement !== 'none') blockers.push('account_not_ready');
    else if (eligible) counts.account_ready++;

    const key = dedupeKey(actor.workspaceId, product, d, releaseScope);
    const dup = await one<{ id: string; state: string }>(db, 'SELECT id, state FROM intents WHERE dedupe_key = ? AND dedupe_active = 1', key);
    if (dup) blockers.push(`duplicate_existing_submission:${dup.state}`);
    else if (eligible && account) counts.not_duplicate++;

    let payload: Record<string, unknown> | null = null;
    if (blockers.length === 0 && adapter) {
      try {
        payload = await adapter.prepare({ product, destination: d, earliestDate: input.earliestDate, latestDate: input.latestDate, readAsset: deps.readAsset });
      } catch (e) {
        blockers.push(`prepare_failed:${e instanceof SubmitFleetError ? e.code : 'error'}`);
      }
    }
    const executable = blockers.length === 0 && payload !== null;
    if (executable) {
      counts.executable++;
      seenGroups.add(d.listing_group);
    }
    targets.push({
      destination: d.slug,
      destination_id: d.id,
      listing_group: d.listing_group,
      executable,
      blockers,
      account_id: account?.id ?? null,
      payload,
      payload_hash: payload ? hashValue(payload) : null,
    });
  }

  const status = counts.executable >= min ? 'draft' : 'coverage_insufficient';
  const ts = nowIso();
  const id = campaignId ?? newId('cmp');
  if (campaignId) {
    const c = await getCampaign(db, actor.workspaceId, campaignId);
    if (!['draft', 'coverage_insufficient', 'awaiting_approval', 'approved'].includes(c.status)) {
      throw new SubmitFleetError('campaign_not_replannable', `campaign is ${c.status}`);
    }
    await run(db, "UPDATE approvals SET status = 'invalidated', reason = 'replanned', decided_at = ? WHERE campaign_id = ? AND status IN ('pending', 'granted')", ts, id);
    await run(db, 'DELETE FROM campaign_targets WHERE campaign_id = ?', id);
    await run(
      db,
      'UPDATE campaigns SET status = ?, min_executable = ?, release_scope = ?, spend_limit_cents = ?, earliest_date = ?, latest_date = ?, executable_count = ?, updated_at = ? WHERE id = ?',
      status, min, releaseScope, input.spendLimitCents ?? 0, input.earliestDate, input.latestDate, counts.executable, ts, id,
    );
  } else {
    await run(
      db,
      `INSERT INTO campaigns (id, workspace_id, product_id, status, min_executable, release_scope, policy_json, spend_limit_cents, earliest_date, latest_date, executable_count, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, actor.workspaceId, product.id, status, min, releaseScope, JSON.stringify(DEFAULT_POLICY), input.spendLimitCents ?? 0,
      input.earliestDate, input.latestDate, counts.executable, actor.id, ts, ts,
    );
  }
  for (const t of targets) {
    await run(
      db,
      'INSERT INTO campaign_targets (id, campaign_id, destination_id, account_id, executable, blockers_json, payload_json, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId('tgt'), id, t.destination_id, t.account_id, t.executable ? 1 : 0, JSON.stringify(t.blockers), t.payload ? JSON.stringify(t.payload) : null, t.payload_hash,
    );
  }
  return {
    campaign: await getCampaign(db, actor.workspaceId, id),
    counts,
    targets: targets.map(({ destination_id: _d, payload: _p, ...t }) => t),
  };
}

interface TargetRow {
  destination_id: string;
  slug: string;
  adapter_id: string | null;
  adapter_version: string | null;
  account_id: string | null;
  executable: number;
  blockers_json: string;
  payload_json: string | null;
  payload_hash: string | null;
}

async function targetRows(db: Db, campaignId: string): Promise<TargetRow[]> {
  return all<TargetRow>(
    db,
    `SELECT t.destination_id, d.slug, d.adapter_id, d.adapter_version, t.account_id, t.executable, t.blockers_json, t.payload_json, t.payload_hash
     FROM campaign_targets t JOIN destinations d ON d.id = t.destination_id WHERE t.campaign_id = ? ORDER BY d.slug`,
    campaignId,
  );
}

/** The exact bounded thing an owner approves. Any change to it changes the hash. */
export async function approvalScope(db: Db, c: Campaign): Promise<Record<string, unknown>> {
  const product = await requireProduct(db, c.workspace_id, c.product_id);
  const targets = (await targetRows(db, c.id))
    .filter((t) => Number(t.executable) === 1)
    .map((t) => ({ destination: t.slug, adapter: `${t.adapter_id}@${t.adapter_version}`, account_id: t.account_id, payload_hash: t.payload_hash }));
  return {
    campaign_id: c.id,
    product: { id: product.id, canonical_key: product.canonical_key, content_hash: productContentHash(product), facts_approved_at: product.approved_at },
    targets,
    min_executable: c.min_executable,
    release_scope: c.release_scope,
    earliest_date: c.earliest_date,
    latest_date: c.latest_date,
    spend_limit_cents: c.spend_limit_cents,
    listing_spend_limit_cents: 0,
    policy: c.policy,
  };
}

export async function previewCampaign(db: Db, workspaceId: string, id: string) {
  const c = await getCampaign(db, workspaceId, id);
  const rows = await targetRows(db, id);
  const scope = await approvalScope(db, c);
  return {
    campaign: c,
    scope_hash: hashValue(scope),
    executable: rows.filter((t) => Number(t.executable) === 1).map((t) => ({ destination: t.slug, account_id: t.account_id, payload: parseJson(t.payload_json, {}) })),
    blocked: rows.filter((t) => Number(t.executable) !== 1).map((t) => ({ destination: t.slug, blockers: parseJson<string[]>(t.blockers_json, []) })),
  };
}

export async function requestApproval(db: Db, actor: Actor, campaignId: string): Promise<{ approval_id: string; scope_hash: string }> {
  const c = await getCampaign(db, actor.workspaceId, campaignId);
  if (c.status === 'coverage_insufficient') {
    throw new SubmitFleetError('coverage_insufficient', `${c.executable_count} executable, ${c.min_executable} required`, { executable: c.executable_count, required: c.min_executable });
  }
  if (c.status !== 'draft' && c.status !== 'awaiting_approval') throw new SubmitFleetError('invalid_state', `campaign is ${c.status}`);
  const scope = await approvalScope(db, c);
  const id = newId('apr');
  const ts = nowIso();
  await run(db, "UPDATE approvals SET status = 'invalidated', reason = 'superseded', decided_at = ? WHERE campaign_id = ? AND status = 'pending'", ts, campaignId);
  await run(
    db,
    "INSERT INTO approvals (id, workspace_id, campaign_id, scope_hash, scope_json, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    id, actor.workspaceId, campaignId, hashValue(scope), JSON.stringify(scope), actor.id, ts,
  );
  await run(db, "UPDATE campaigns SET status = 'awaiting_approval', updated_at = ? WHERE id = ?", ts, campaignId);
  return { approval_id: id, scope_hash: hashValue(scope) };
}

/** Only the owner can grant, and only for the scope as it stands right now. */
export async function grantApproval(db: Db, actor: Actor, campaignId: string, expectedScopeHash?: string): Promise<{ approval_id: string; scope_hash: string }> {
  requireOwner(actor);
  const c = await getCampaign(db, actor.workspaceId, campaignId);
  const pending = await one<{ id: string; scope_hash: string; requested_by: string }>(
    db,
    "SELECT id, scope_hash, requested_by FROM approvals WHERE campaign_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    campaignId,
  );
  if (!pending) throw new SubmitFleetError('no_pending_approval', 'request approval first');
  const current = hashValue(await approvalScope(db, c));
  const ts = nowIso();
  if (current !== pending.scope_hash || (expectedScopeHash && expectedScopeHash !== current)) {
    await run(db, "UPDATE approvals SET status = 'invalidated', reason = 'scope_changed', decided_at = ? WHERE id = ?", ts, pending.id);
    throw new SubmitFleetError('approval_invalidated', 'the campaign changed after approval was requested; preview and request again');
  }
  await run(db, "UPDATE approvals SET status = 'granted', decided_by = ?, decided_at = ? WHERE id = ?", actor.id, ts, pending.id);
  await run(db, "UPDATE campaigns SET status = 'approved', updated_at = ? WHERE id = ?", ts, campaignId);
  return { approval_id: pending.id, scope_hash: current };
}

/** Queues intents for an approved campaign after re-checking the approval still matches. */
export async function runCampaign(db: Db, actor: Actor, campaignId: string): Promise<{ queued: number; duplicates: string[] }> {
  const c = await getCampaign(db, actor.workspaceId, campaignId);
  if (c.status === 'paused') {
    await run(db, "UPDATE campaigns SET status = 'running', updated_at = ? WHERE id = ?", nowIso(), campaignId);
    return { queued: 0, duplicates: [] };
  }
  if (c.status !== 'approved') throw new SubmitFleetError('not_approved', `campaign is ${c.status}`);
  const approval = await one<{ id: string; scope_hash: string }>(
    db,
    "SELECT id, scope_hash FROM approvals WHERE campaign_id = ? AND status = 'granted' ORDER BY decided_at DESC LIMIT 1",
    campaignId,
  );
  if (!approval) throw new SubmitFleetError('not_approved');
  const ts = nowIso();
  if (hashValue(await approvalScope(db, c)) !== approval.scope_hash) {
    await run(db, "UPDATE approvals SET status = 'invalidated', reason = 'scope_changed', decided_at = ? WHERE id = ?", ts, approval.id);
    await run(db, "UPDATE campaigns SET status = 'draft', updated_at = ? WHERE id = ?", ts, campaignId);
    throw new SubmitFleetError('approval_invalidated', 'material change since approval');
  }
  const product = await requireProduct(db, actor.workspaceId, c.product_id);
  const rows = (await targetRows(db, campaignId)).filter((t) => Number(t.executable) === 1);
  const duplicates: string[] = [];
  let queued = 0;
  await createBudget(db, actor.workspaceId, campaignId, c.spend_limit_cents);
  for (const t of rows) {
    const d = (await one<Record<string, unknown>>(db, 'SELECT listing_group FROM destinations WHERE id = ?', t.destination_id))!;
    const key = dedupeKey(actor.workspaceId, product, { listing_group: String(d.listing_group) } as Destination, c.release_scope);
    const id = newId('int');
    try {
      // Intent is persisted before any external action is attempted.
      await run(
        db,
        `INSERT INTO intents (id, workspace_id, campaign_id, product_id, destination_id, account_id, approval_id, dedupe_key, state, payload_json, payload_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        id, actor.workspaceId, campaignId, product.id, t.destination_id, t.account_id, approval.id, key, t.payload_json, t.payload_hash, ts, ts,
      );
      await appendEvent(db, id, 'queued', { to: 'queued' });
      queued++;
    } catch (e) {
      if (String(e).includes('UNIQUE')) duplicates.push(t.slug);
      else throw e;
    }
  }
  await run(db, "UPDATE campaigns SET status = 'running', updated_at = ? WHERE id = ?", ts, campaignId);
  return { queued, duplicates };
}

export async function pauseCampaign(db: Db, workspaceId: string, id: string): Promise<void> {
  const n = await run(db, "UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'running'", nowIso(), id, workspaceId);
  if (!n) throw new SubmitFleetError('invalid_state', 'only a running campaign can be paused');
}

/** Cancels unsent work. Remote listings already created are untouched and stay reported. */
export async function cancelCampaign(db: Db, workspaceId: string, id: string): Promise<{ canceled: number; already_external: number }> {
  const c = await getCampaign(db, workspaceId, id);
  if (['canceled', 'completed'].includes(c.status)) throw new SubmitFleetError('invalid_state', `campaign is ${c.status}`);
  const ts = nowIso();
  await run(db, "UPDATE campaigns SET status = 'canceled', updated_at = ? WHERE id = ?", ts, id);
  await run(db, "UPDATE approvals SET status = 'invalidated', reason = 'canceled', decided_at = ? WHERE campaign_id = ? AND status IN ('pending', 'granted')", ts, id);
  const rows = await all<{ id: string }>(db, "SELECT id FROM intents WHERE campaign_id = ? AND state IN ('queued', 'needs_human') AND external_action_performed = 0", id);
  for (const r of rows) {
    const n = await run(db, "UPDATE intents SET state = 'canceled', dedupe_active = 0, reason_code = 'campaign_canceled', updated_at = ? WHERE id = ? AND state IN ('queued', 'needs_human') AND external_action_performed = 0", ts, r.id);
    if (n) await appendEvent(db, r.id, 'canceled', { to: 'canceled' });
  }
  const ext = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM intents WHERE campaign_id = ? AND external_action_performed = 1', id);
  return { canceled: rows.length, already_external: Number(ext?.n ?? 0) };
}

export async function campaignStatus(db: Db, workspaceId: string, id: string) {
  const c = await getCampaign(db, workspaceId, id);
  const states = await all<{ state: string; n: number }>(db, 'SELECT state, COUNT(*) AS n FROM intents WHERE campaign_id = ? GROUP BY state', id);
  const by: Record<string, number> = {};
  for (const s of states) by[s.state] = Number(s.n);
  return { campaign: c, intents: by };
}
