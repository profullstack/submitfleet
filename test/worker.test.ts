import { afterEach, describe, expect, it } from 'vitest';
import { createBudget, reserve } from '../src/budgets.js';
import { all, one, run } from '../src/db.js';
import { getIntent } from '../src/ledger.js';
import { approvedProduct, fakeAdapter, harness, launch, qualifyingDestination, seedDestinations, vaultUp, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const intents = (h: Harness) => all<{ id: string; state: string; reason_code: string | null; fence: number }>(h.fleet.db, 'SELECT id, state, reason_code, fence FROM intents ORDER BY created_at');

describe('durable execution', () => {
  it('7a. concurrent workers on separate connections execute each intent exactly once', async () => {
    const adapter = fakeAdapter('fake', {
      execute: async (ctx) => {
        await new Promise((r) => setTimeout(r, 5));
        return { kind: 'submitted', remoteId: ctx.intentId, receiptId: `r-${ctx.intentId}`, evidence: {} };
      },
    });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 30);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 30);
    const others = await Promise.all([h.reopen(), h.reopen(), h.reopen()]);
    const workers = [h.fleet, ...others].map((f, i) => f.worker({ workerId: `w${i}` }));
    await Promise.all(workers.map((w) => w.tick(30)));
    expect(adapter.calls.execute).toHaveLength(30);
    expect(new Set(adapter.calls.execute).size).toBe(30);
    expect((await intents(h)).every((i) => i.state === 'submitted')).toBe(true);
  });

  it('7b. a timeout after a possible write is uncertain and is reconciled, never blindly retried', async () => {
    let first = true;
    const adapter = fakeAdapter('fake', {
      execute: async (ctx) => {
        if (first) {
          first = false;
          await ctx.recordRemote({ draft: 1 });
          await new Promise((r) => setTimeout(r, 300));
        }
        return { kind: 'submitted', remoteId: 'x', receiptId: 'rx', evidence: {} };
      },
      reconcile: async () => ({ status: 'found', state: 'submitted', remoteId: 'found-remote', listingUrl: 'https://dest-0.example/p', evidence: { matched: true } }),
    });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);
    const w = h.fleet.worker({ execTimeoutMs: 50 });
    await w.tick();
    let [i] = await intents(h);
    expect(i!.state).toBe('uncertain');
    expect(i!.reason_code).toBe('timeout');
    expect(adapter.calls.execute).toHaveLength(1);
    await w.tick();
    [i] = await intents(h);
    expect(i!.state).toBe('submitted');
    expect(adapter.calls.execute).toHaveLength(1);
    expect(adapter.calls.reconcile).toHaveLength(1);
  });

  it('7c. an expired lease becomes uncertain; a stale worker cannot complete after takeover', async () => {
    let clock = Date.now();
    const adapter = fakeAdapter('fake', { reconcile: async () => ({ status: 'unknown', reasonCode: 'cannot_tell' }) });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);
    const f2 = await h.reopen();
    const w1 = h.fleet.worker({ leaseMs: 1000 });
    (w1 as unknown as { now: () => number }).now = () => clock;
    const claimed = await w1.claim();
    expect(claimed).not.toBeNull();
    clock += 5000;
    const w2 = f2.worker();
    (w2 as unknown as { now: () => number }).now = () => clock;
    expect(await w2.recoverExpiredLeases()).toBe(1);
    // w1 finishes late with its old fence: the write is rejected.
    await w1.execute(claimed!);
    const i = await getIntent(h.fleet.db, h.owner.workspaceId, claimed!.id);
    expect(i.state).toBe('uncertain');
    const ev = await all<{ kind: string }>(h.fleet.db, 'SELECT kind FROM intent_events WHERE intent_id = ?', i.id);
    expect(ev.map((e) => e.kind)).toContain('stale_transition_rejected');
    // Unknown reconciliation eventually asks a human rather than retrying.
    for (let k = 0; k < 5; k++) await w2.reconcileUncertain();
    expect((await getIntent(h.fleet.db, h.owner.workspaceId, i.id)).state).toBe('needs_human');
    expect(adapter.calls.execute).toHaveLength(1);
  });

  it('reconciled absence is the only path from uncertain back to the queue', async () => {
    let calls = 0;
    const adapter = fakeAdapter('fake', {
      execute: async () => (++calls === 1 ? { kind: 'uncertain', reasonCode: 'http_502' } : { kind: 'submitted', remoteId: 'ok', receiptId: 'r', evidence: {} }),
      reconcile: async () => ({ status: 'absent', evidence: { searched: true } }),
    });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);
    const w = h.fleet.worker();
    await w.tick();
    expect((await intents(h))[0]!.state).toBe('uncertain');
    await w.tick();
    expect((await intents(h))[0]!.state).toBe('submitted');
    expect(calls).toBe(2);
  });

  it('6. account-wide queue limits apply across campaigns and workers', async () => {
    h = await harness();
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login', queue_limit_per_account: 1, queue_window_hours: 24 }));
    await vaultUp(h.fleet, h.owner);
    const acct = await h.fleet.accountConnectSecret(h.owner, 'dest-0', 'main', { token: 't' }, null);
    const a = await approvedProduct(h.fleet, h.owner, 'https://a.example');
    const b = await approvedProduct(h.fleet, h.owner, 'https://b.example');
    await launch(h, a.id, 1);
    await launch(h, b.id, 1);
    const f2 = await h.reopen();
    await Promise.all([h.fleet.worker().tick(5), f2.worker().tick(5)]);
    const rows = await all<{ state: string; account_id: string }>(h.fleet.db, 'SELECT state, account_id FROM intents');
    expect(rows.every((r) => r.account_id === acct.id)).toBe(true);
    expect(rows.map((r) => r.state).sort()).toEqual(['queued', 'submitted']);
  });

  it('14. pause stops new writes; cancel cancels unsent work without claiming remote deletion', async () => {
    const adapter = fakeAdapter();
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 4);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 4);
    const w = h.fleet.worker();
    await w.tick(1);
    await h.fleet.pauseAll(h.agent);
    await w.tick(10);
    expect(adapter.calls.execute).toHaveLength(1);
    await expect(h.fleet.resumeAll(h.agent)).rejects.toMatchObject({ code: 'owner_required' });
    await h.fleet.resumeAll(h.owner);
    await h.fleet.campaignPause(h.owner, plan.campaign.id);
    await w.tick(10);
    expect(adapter.calls.execute).toHaveLength(1);
    const res = await h.fleet.campaignCancel(h.owner, plan.campaign.id);
    expect(res).toEqual({ canceled: 3, already_external: 1 });
    const states = (await intents(h)).map((i) => i.state).sort();
    expect(states).toEqual(['canceled', 'canceled', 'canceled', 'submitted']);
  });

  it('disconnecting an account or disabling a destination stops new writes', async () => {
    const adapter = fakeAdapter();
    h = await harness([adapter]);
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(1));
    await vaultUp(h.fleet, h.owner);
    const acct = await h.fleet.accountConnectSecret(h.owner, 'dest-0', 'main', { token: 't' }, null);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 2);
    await h.fleet.accountDisconnect(h.owner, acct.id);
    await h.fleet.catalogUpsert(h.owner, { ...qualifyingDestination(1), disabled: true });
    await h.fleet.worker().tick(10);
    expect(adapter.calls.execute).toHaveLength(0);
  });

  it('13. restarts preserve jobs, approvals, costs and receipts', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 2);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 2, { spendLimitCents: 500 });
    await h.fleet.worker().tick(1);
    h.fleet.close();
    const f = await h.reopen();
    const st = await f.campaignStatus(h.owner, plan.campaign.id);
    expect(st.intents).toEqual({ submitted: 1, queued: 1 });
    expect(await one(f.db, "SELECT id FROM approvals WHERE status = 'granted' AND campaign_id = ?", plan.campaign.id)).not.toBeNull();
    expect(await one(f.db, 'SELECT limit_cents FROM budgets WHERE campaign_id = ?', plan.campaign.id)).toMatchObject({ limit_cents: 500 });
    await f.worker().tick(5);
    const r = await f.reportGet(h.owner, plan.campaign.id);
    expect(r.submissions.filter((s) => s.receipt_id)).toHaveLength(2);
    (h as { fleet: typeof f }).fleet = f;
  });

  it('15. concurrent budget reservations enforce the spending bound', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 1);
    const budgetId = await createBudget(h.fleet.db, h.owner.workspaceId, plan.campaign.id, 100);
    const [intent] = await intents(h);
    const others = await Promise.all([h.reopen(), h.reopen()]);
    const dbs = [h.fleet.db, ...others.map((o) => o.db)];
    const results = await Promise.all(Array.from({ length: 30 }, (_, k) => reserve(dbs[k % 3]!, budgetId, intent!.id, 10)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await one(h.fleet.db, 'SELECT reserved_cents FROM budgets WHERE id = ?', budgetId)).toMatchObject({ reserved_cents: 100 });
  });

  it('a job whose estimated cost exceeds the budget goes to the human queue unexecuted', async () => {
    const adapter = fakeAdapter();
    adapter.prepare = async ({ product }) => ({ name: product.name, _estimated_cost_cents: 50 });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1, { spendLimitCents: 10 });
    await h.fleet.worker().tick();
    expect((await intents(h))[0]).toMatchObject({ state: 'needs_human', reason_code: 'budget_exhausted' });
    expect(adapter.calls.execute).toHaveLength(0);
  });

  it('stale fee or permission evidence blocks the write until refreshed', async () => {
    const adapter = fakeAdapter();
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);
    await run(h.fleet.db, 'UPDATE destinations SET fee_checked_at = ?', new Date(Date.now() - 48 * 3_600_000).toISOString());
    await h.fleet.worker().tick();
    expect((await intents(h))[0]).toMatchObject({ state: 'needs_human', reason_code: 'fee_evidence_stale' });
    expect(adapter.calls.execute).toHaveLength(0);
  });

  it('10. a challenge produces a scoped handoff, not a bypass', async () => {
    const adapter = fakeAdapter('fake', { execute: async () => ({ kind: 'needs_human', reasonCode: 'captcha_required', externalActionPerformed: false }) });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);
    await h.fleet.worker().tick();
    const q = await h.fleet.humanQueue(h.owner);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ state: 'needs_human', reason_code: 'captcha_required', destination: 'dest-0' });
    await expect(h.fleet.submissionRequeue(h.agent, String(q[0]!.id))).rejects.toMatchObject({ code: 'owner_required' });
    expect(await h.fleet.submissionRequeue(h.owner, String(q[0]!.id))).toBe(true);
  });

  it('intent events are append-only', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);
    await expect(run(h.fleet.db, 'DELETE FROM intent_events')).rejects.toThrow(/append-only/);
    await expect(run(h.fleet.db, "UPDATE intent_events SET kind = 'x'")).rejects.toThrow(/append-only/);
  });
});
