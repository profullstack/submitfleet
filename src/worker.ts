import type { Adapter, ExecContext, ExecResult } from './adapters/types.js';
import { getBudget, release, reserve, settle } from './budgets.js';
import { getDestination, WRITE_EVIDENCE_MAX_AGE_HOURS, type Destination } from './catalog.js';
import { all, type Db } from './db.js';
import { appendEvent, intentById, recordRemoteRefs, rowToIntent, transition, type Intent } from './ledger.js';
import { OCCUPYING_STATES } from './state.js';
import { newId, nowIso, SubmitFleetError } from './util.js';
import { markNeedsReauth, readAccountSecret } from './workspaces.js';

export interface WorkerOptions {
  db: Db;
  adapters: Map<string, Adapter>;
  secretKey: Buffer | null;
  workerId?: string;
  leaseMs?: number;
  execTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Uncertain intents still unknown after this many reconcile attempts go to the human queue. */
  maxReconcileAttempts?: number;
}

const occupying = OCCUPYING_STATES.map((s) => `'${s}'`).join(', ');

export class Worker {
  readonly id: string;
  private db: Db;
  private adapters: Map<string, Adapter>;
  private leaseMs: number;
  private execTimeoutMs: number;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private maxReconcile: number;

  constructor(private opts: WorkerOptions) {
    this.id = opts.workerId ?? newId('wrk');
    this.db = opts.db;
    this.adapters = opts.adapters;
    this.leaseMs = opts.leaseMs ?? 120_000;
    this.execTimeoutMs = opts.execTimeoutMs ?? 90_000;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.maxReconcile = opts.maxReconcileAttempts ?? 5;
  }

  /** One pass: recover expired leases, reconcile uncertain work, execute up to `max` intents. */
  async tick(max = 10): Promise<{ recovered: number; reconciled: number; executed: number }> {
    const recovered = await this.recoverExpiredLeases();
    const reconciled = await this.reconcileUncertain();
    let executed = 0;
    for (; executed < max; executed++) {
      const intent = await this.claim();
      if (!intent) break;
      await this.execute(intent);
    }
    return { recovered, reconciled, executed };
  }

  /**
   * Atomic claim. One UPDATE ... WHERE id = (SELECT ...) both selects and leases, and
   * re-checks pause, campaign state, destination health, account state, per-account
   * queue limits and cooldowns inside the same statement, so concurrent workers
   * cannot both take a slot.
   */
  async claim(): Promise<Intent | null> {
    const now = nowIso(this.now);
    const lease = new Date(this.now() + this.leaseMs).toISOString();
    const rows = await all<Record<string, unknown>>(
      this.db,
      `UPDATE intents SET state = 'executing', lease_owner = ?, lease_expires_at = ?, fence = fence + 1, attempts = attempts + 1, updated_at = ?
       WHERE state = 'queued' AND id = (
         SELECT i.id FROM intents i
         JOIN campaigns c ON c.id = i.campaign_id AND c.status = 'running'
         JOIN workspaces w ON w.id = i.workspace_id AND w.paused = 0
         JOIN destinations d ON d.id = i.destination_id AND d.disabled = 0 AND d.archived = 0 AND d.adapter_health = 'healthy'
         LEFT JOIN accounts a ON a.id = i.account_id
         WHERE i.state = 'queued'
           AND (i.account_id IS NULL OR a.status = 'connected')
           AND (d.queue_limit_per_account IS NULL OR (
             SELECT COUNT(*) FROM intents o
             WHERE o.destination_id = i.destination_id AND o.account_id IS i.account_id AND o.state IN (${occupying})
               AND (d.queue_window_hours IS NULL OR COALESCE(o.submitted_at, o.updated_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || d.queue_window_hours || ' hours'))
           ) < d.queue_limit_per_account)
           AND (d.cooldown_hours IS NULL OR NOT EXISTS (
             SELECT 1 FROM intents o
             WHERE o.destination_id = i.destination_id AND o.account_id IS i.account_id AND o.submitted_at IS NOT NULL
               AND o.submitted_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || d.cooldown_hours || ' hours')
           ))
         ORDER BY i.created_at LIMIT 1
       )
       RETURNING *`,
      this.id, lease, now, now, now,
    );
    const r = rows[0];
    if (!r) return null;
    const intent = rowToIntent(r);
    await appendEvent(this.db, intent.id, 'claimed', { from: 'queued', to: 'executing', fence: intent.fence, worker: this.id });
    return intent;
  }

  async execute(intent: Intent): Promise<void> {
    const fence = intent.fence;
    const d = await getDestination(this.db, intent.destination_id);
    const adapter = d?.adapter_id ? this.adapters.get(d.adapter_id) : undefined;
    if (!d || !adapter) {
      await transition(this.db, intent, 'failed', { reason_code: 'adapter_unavailable', release_dedupe: true, clear_lease: true }, fence);
      return;
    }

    const stale = staleEvidence(d, this.now());
    if (stale) {
      await transition(this.db, intent, 'needs_human', { reason_code: stale, clear_lease: true }, fence);
      return;
    }

    const budget = await getBudget(this.db, intent.campaign_id);
    const estimate = Number(intent.payload._estimated_cost_cents ?? 0);
    const reservation = budget ? await reserve(this.db, budget.id, intent.id, estimate) : null;
    if (!reservation) {
      await transition(this.db, intent, 'needs_human', { reason_code: 'budget_exhausted', clear_lease: true }, fence);
      return;
    }

    const ctl = new AbortController();
    const ctx = this.context(intent, d, ctl.signal);
    let result: ExecResult;
    try {
      const pre = await adapter.preflight(ctx);
      if (!pre.ok) {
        await release(this.db, reservation);
        await transition(this.db, intent, 'needs_human', { reason_code: pre.reasonCode ?? 'preflight_failed', clear_lease: true, evidence: pre.evidence }, fence);
        return;
      }
      result = await withTimeout(adapter.execute(ctx), this.execTimeoutMs, ctl);
    } catch (e) {
      // A throw or timeout after a possible write is uncertain, never failed.
      result = { kind: 'uncertain', reasonCode: e instanceof TimeoutError ? 'timeout' : `exception:${e instanceof SubmitFleetError ? e.code : 'error'}` };
    }

    const actual = 'costCents' in result && typeof result.costCents === 'number' ? result.costCents : estimate;
    const { charged } = await settle(this.db, reservation, actual);
    await this.applyResult(intent, result, fence, charged);
  }

  private async applyResult(intent: Intent, result: ExecResult, fence: number, charged: number): Promise<void> {
    const ts = nowIso(this.now);
    switch (result.kind) {
      case 'submitted':
      case 'scheduled':
        await transition(
          this.db,
          intent,
          result.kind,
          { external_action_performed: true, remote_id: result.remoteId, receipt_id: result.receiptId, listing_url: result.listingUrl ?? null, submitted_at: ts, cost_cents: charged, clear_lease: true, evidence: result.evidence },
          fence,
        );
        return;
      case 'needs_human':
        if (result.reasonCode === 'session_expired' && intent.account_id) await markNeedsReauth(this.db, intent.account_id);
        await transition(this.db, intent, 'needs_human', { reason_code: result.reasonCode, external_action_performed: result.externalActionPerformed, cost_cents: charged, clear_lease: true, evidence: result.evidence }, fence);
        return;
      case 'failed': {
        const fresh = await intentById(this.db, intent.id);
        const external = result.externalActionPerformed || !!fresh?.external_action_performed;
        await transition(
          this.db,
          intent,
          'failed',
          { reason_code: result.reasonCode, external_action_performed: external, release_dedupe: !external, cost_cents: charged, clear_lease: true, evidence: result.evidence },
          fence,
        );
        return;
      }
      case 'uncertain':
        await transition(this.db, intent, 'uncertain', { reason_code: result.reasonCode, cost_cents: charged, clear_lease: true, evidence: result.evidence }, fence);
        return;
    }
  }

  /** A lease that expired mid-execution may have written remotely: mark uncertain, never requeue. */
  async recoverExpiredLeases(): Promise<number> {
    const now = nowIso(this.now);
    const rows = await all<{ id: string; fence: number }>(
      this.db,
      "UPDATE intents SET state = 'uncertain', reason_code = 'lease_expired', fence = fence + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'executing' AND lease_expires_at < ? RETURNING id, fence",
      now,
      now,
    );
    for (const r of rows) await appendEvent(this.db, r.id, 'lease_expired', { from: 'executing', to: 'uncertain', fence: Number(r.fence) });
    return rows.length;
  }

  /** Reconcile before any retry: only definitive absence lets an uncertain intent run again. */
  async reconcileUncertain(limit = 20): Promise<number> {
    const rows = await all<Record<string, unknown>>(
      this.db,
      `SELECT i.* FROM intents i JOIN workspaces w ON w.id = i.workspace_id AND w.paused = 0 WHERE i.state = 'uncertain' ORDER BY i.updated_at LIMIT ?`,
      limit,
    );
    let done = 0;
    for (const r of rows) {
      const intent = rowToIntent(r);
      const d = await getDestination(this.db, intent.destination_id);
      const adapter = d?.adapter_id ? this.adapters.get(d.adapter_id) : undefined;
      if (!d || !adapter) continue;
      const ctl = new AbortController();
      let res;
      try {
        res = await withTimeout(adapter.reconcile(this.context(intent, d, ctl.signal)), this.execTimeoutMs, ctl);
      } catch {
        res = { status: 'unknown' as const, reasonCode: 'reconcile_error' };
      }
      const prior = await all<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM intent_events WHERE intent_id = ? AND kind = 'reconcile'", intent.id);
      await appendEvent(this.db, intent.id, 'reconcile', { result: res.status, fence: intent.fence });
      if (res.status === 'found') {
        const to = res.state === 'submitted' || res.state === 'scheduled' ? res.state : 'submitted';
        await transition(this.db, intent, to, { external_action_performed: true, remote_id: res.remoteId ?? intent.remote_id, listing_url: res.listingUrl ?? null, submitted_at: nowIso(this.now), reason_code: 'reconciled', evidence: res.evidence }, intent.fence);
      } else if (res.status === 'absent') {
        await transition(this.db, intent, 'queued', { reason_code: 'reconciled_absent', evidence: res.evidence }, intent.fence);
      } else if (Number(prior[0]?.n ?? 0) + 1 >= this.maxReconcile) {
        await transition(this.db, intent, 'needs_human', { reason_code: `uncertain_unresolved:${res.reasonCode}` }, intent.fence);
      }
      done++;
    }
    return done;
  }

  /** Checks a submitted/scheduled listing for publication, rejection or removal. */
  async reconcileOutcome(intent: Intent): Promise<string> {
    const d = await getDestination(this.db, intent.destination_id);
    const adapter = d?.adapter_id ? this.adapters.get(d.adapter_id) : undefined;
    if (!d || !adapter) throw new SubmitFleetError('adapter_unavailable');
    const ctl = new AbortController();
    const res = await withTimeout(adapter.reconcile(this.context(intent, d, ctl.signal)), this.execTimeoutMs, ctl);
    await appendEvent(this.db, intent.id, 'reconcile', { result: res.status, state: res.status === 'found' ? res.state : undefined });
    if (res.status !== 'found' || res.state === intent.state) return intent.state;
    const ts = nowIso(this.now);
    const ok = await transition(this.db, intent, res.state, {
      listing_url: res.listingUrl ?? undefined,
      published_at: res.state === 'published_verified' ? ts : undefined,
      removed_at: res.state === 'removal_observed' ? ts : undefined,
      evidence: res.evidence,
    }).catch(() => false);
    return ok ? res.state : intent.state;
  }

  private context(intent: Intent, d: Destination, signal: AbortSignal): ExecContext {
    const { db, secretKey } = this.opts;
    return {
      intentId: intent.id,
      payload: intent.payload,
      destination: d,
      remoteRefs: intent.remote_refs,
      recordRemote: (refs) => recordRemoteRefs(db, intent.id, intent.fence, refs),
      credentials: async () => {
        if (!intent.account_id) return {};
        if (!secretKey) throw new SubmitFleetError('secret_key_missing');
        return readAccountSecret(db, secretKey, intent.workspace_id, intent.account_id);
      },
      fetch: this.fetchImpl,
      signal,
      now: this.now,
    };
  }
}

export function staleEvidence(d: Destination, now: number): string | null {
  const max = WRITE_EVIDENCE_MAX_AGE_HOURS * 3_600_000;
  const age = (iso: string | null) => (iso ? now - Date.parse(iso) : Infinity);
  if (d.fee_status !== 'verified_free') return 'fee_not_verified_free';
  if (age(d.fee_checked_at) > max) return 'fee_evidence_stale';
  if (age(d.permission_checked_at) > max) return 'permission_evidence_stale';
  return null;
}

class TimeoutError extends Error {}

async function withTimeout<T>(p: Promise<T>, ms: number, ctl: AbortController): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      ctl.abort();
      reject(new TimeoutError('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}
