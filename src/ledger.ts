import { all, one, run, type Db } from './db.js';
import { assertTransition, type IntentState } from './state.js';
import { nowIso, parseJson, redact, SubmitFleetError } from './util.js';

export interface Intent {
  id: string;
  workspace_id: string;
  campaign_id: string;
  product_id: string;
  destination_id: string;
  account_id: string | null;
  approval_id: string;
  dedupe_key: string;
  state: IntentState;
  reason_code: string | null;
  mode: 'auto' | 'assisted';
  note: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fence: number;
  attempts: number;
  external_action_performed: boolean;
  remote_id: string | null;
  remote_refs: Record<string, unknown>;
  receipt_id: string | null;
  listing_url: string | null;
  cost_cents: number;
  submitted_at: string | null;
  published_at: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToIntent(r: Record<string, unknown>): Intent {
  return {
    ...(r as unknown as Intent),
    payload: parseJson(r.payload_json, {}),
    remote_refs: parseJson(r.remote_refs_json, {}),
    fence: Number(r.fence),
    attempts: Number(r.attempts),
    cost_cents: Number(r.cost_cents),
    external_action_performed: Number(r.external_action_performed) === 1,
  };
}

export async function appendEvent(db: Db, intentId: string, kind: string, data: { from?: string; to?: string; fence?: number; [k: string]: unknown } = {}): Promise<void> {
  const { from, to, fence, ...rest } = data;
  await run(
    db,
    'INSERT INTO intent_events (intent_id, at, kind, fence, from_state, to_state, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    intentId, nowIso(), kind, fence, from, to, JSON.stringify(redact(rest)),
  );
}

export async function getIntent(db: Db, workspaceId: string, id: string): Promise<Intent> {
  const r = await one<Record<string, unknown>>(db, 'SELECT * FROM intents WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!r) throw new SubmitFleetError('not_found', `submission ${id}`);
  return rowToIntent(r);
}

export async function intentById(db: Db, id: string): Promise<Intent | null> {
  const r = await one<Record<string, unknown>>(db, 'SELECT * FROM intents WHERE id = ?', id);
  return r ? rowToIntent(r) : null;
}

export async function listIntents(db: Db, workspaceId: string, campaignId: string): Promise<Intent[]> {
  const rows = await all<Record<string, unknown>>(db, 'SELECT * FROM intents WHERE workspace_id = ? AND campaign_id = ? ORDER BY created_at', workspaceId, campaignId);
  return rows.map(rowToIntent);
}

export async function intentEvents(db: Db, intentId: string) {
  return all(db, 'SELECT at, kind, fence, from_state, to_state, data_json FROM intent_events WHERE intent_id = ? ORDER BY id', intentId);
}

export interface TransitionPatch {
  reason_code?: string | null;
  external_action_performed?: boolean;
  remote_id?: string | null;
  receipt_id?: string | null;
  listing_url?: string | null;
  cost_cents?: number;
  submitted_at?: string | null;
  published_at?: string | null;
  removed_at?: string | null;
  release_dedupe?: boolean;
  clear_lease?: boolean;
  bump_fence?: boolean;
}

/**
 * Compare-and-set transition. With `fence`, only the holder of the current lease can
 * complete; a worker whose lease was taken over gets `false` and must not write.
 */
export async function transition(
  db: Db,
  intent: Pick<Intent, 'id' | 'state'>,
  to: IntentState,
  patch: TransitionPatch & { evidence?: Record<string, unknown> } = {},
  fence?: number,
): Promise<boolean> {
  assertTransition(intent.state, to);
  const sets = ['state = ?', 'updated_at = ?'];
  const args: unknown[] = [to, nowIso()];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (patch.reason_code !== undefined) set('reason_code', patch.reason_code);
  if (patch.external_action_performed) sets.push('external_action_performed = 1');
  for (const k of ['remote_id', 'receipt_id', 'listing_url', 'submitted_at', 'published_at', 'removed_at'] as const) {
    if (patch[k] !== undefined) set(k, patch[k]);
  }
  if (patch.cost_cents !== undefined) sets.push(`cost_cents = cost_cents + ${Math.max(0, Math.floor(patch.cost_cents))}`);
  if (patch.release_dedupe) sets.push('dedupe_active = 0');
  if (patch.clear_lease) sets.push('lease_owner = NULL', 'lease_expires_at = NULL');
  if (patch.bump_fence) sets.push('fence = fence + 1');
  let where = 'id = ? AND state = ?';
  args.push(intent.id, intent.state);
  if (fence !== undefined) {
    where += ' AND fence = ?';
    args.push(fence);
  }
  const n = await run(db, `UPDATE intents SET ${sets.join(', ')} WHERE ${where}`, ...args);
  if (n === 1) await appendEvent(db, intent.id, 'transition', { from: intent.state, to, fence, reason: patch.reason_code, evidence: patch.evidence });
  else await appendEvent(db, intent.id, 'stale_transition_rejected', { from: intent.state, to, fence });
  return n === 1;
}

export async function recordRemoteRefs(db: Db, intentId: string, fence: number, refs: Record<string, unknown>): Promise<void> {
  const cur = await one<{ remote_refs_json: string }>(db, 'SELECT remote_refs_json FROM intents WHERE id = ? AND fence = ?', intentId, fence);
  if (!cur) throw new SubmitFleetError('lease_lost', 'fence moved; refusing to record');
  const merged = { ...parseJson<Record<string, unknown>>(cur.remote_refs_json, {}), ...refs };
  // A remote ref means a remote write happened, so the intent can never be blindly retried.
  await run(db, 'UPDATE intents SET remote_refs_json = ?, external_action_performed = 1, updated_at = ? WHERE id = ? AND fence = ?', JSON.stringify(merged), nowIso(), intentId, fence);
  await appendEvent(db, intentId, 'remote_ref', { fence, refs });
}
