import { afterEach, describe, expect, it } from 'vitest';
import { all } from '../src/db.js';
import { approvedProduct, fakeAdapter, harness, launch, qualifyingDestination, seedDestinations, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

describe('campaigns, approvals and reporting', () => {
  it('3. a strict campaign with 73 executable matches makes no submission writes', async () => {
    const adapter = fakeAdapter();
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 73);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await h.fleet.campaignPlan(h.agent, { productId: p.id, minExecutableDestinations: 100 });
    expect(plan.campaign.status).toBe('coverage_insufficient');
    expect(plan.counts.executable).toBe(73);
    await expect(h.fleet.approvalRequest(h.agent, plan.campaign.id)).rejects.toMatchObject({ code: 'coverage_insufficient', detail: { executable: 73, required: 100 } });
    await expect(h.fleet.campaignRun(h.owner, plan.campaign.id)).rejects.toMatchObject({ code: 'not_approved' });
    await h.fleet.worker().tick(100);
    expect(adapter.calls.execute).toHaveLength(0);
    expect(await all(h.fleet.db, 'SELECT id FROM intents')).toHaveLength(0);
  });

  it('the owner can explicitly approve a smaller campaign without waiving the engine gate', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 5);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 5);
    expect(plan.counts.executable).toBe(5);
    expect((await h.fleet.coverageReport()).status).toBe('below_minimum');
  });

  it('8. changed payloads or targets invalidate approvals; agents cannot approve', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 3);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await h.fleet.campaignPlan(h.agent, { productId: p.id, minExecutableDestinations: 3 });
    await h.fleet.approvalRequest(h.agent, plan.campaign.id);
    // Self-approval by the requesting agent fails.
    await expect(h.fleet.approvalGrant(h.agent, plan.campaign.id)).rejects.toMatchObject({ code: 'owner_required' });

    // Material content change after the request: grant is refused.
    await h.fleet.productUpdate(h.owner, p.id, { tagline: 'Now with AI' });
    await h.fleet.productApproveFacts(h.owner, p.id);
    await expect(h.fleet.approvalGrant(h.owner, plan.campaign.id)).rejects.toMatchObject({ code: 'approval_invalidated' });

    // Change after grant: run refuses and drops back to draft.
    await h.fleet.campaignPlan(h.agent, { productId: p.id, minExecutableDestinations: 3 }, plan.campaign.id);
    await h.fleet.approvalRequest(h.agent, plan.campaign.id);
    await h.fleet.approvalGrant(h.owner, plan.campaign.id);
    await h.fleet.productUpdate(h.owner, p.id, { description: 'changed' });
    await h.fleet.productApproveFacts(h.owner, p.id);
    await expect(h.fleet.campaignRun(h.owner, plan.campaign.id)).rejects.toMatchObject({ code: 'approval_invalidated' });
    expect(await all(h.fleet.db, 'SELECT id FROM intents')).toHaveLength(0);

    // Spend limit is part of the scope too.
    const p2 = await approvedProduct(h.fleet, h.owner, 'https://other.example');
    const plan2 = await h.fleet.campaignPlan(h.agent, { productId: p2.id, minExecutableDestinations: 3, spendLimitCents: 0 });
    const req = await h.fleet.approvalRequest(h.agent, plan2.campaign.id);
    await expect(h.fleet.approvalGrant(h.owner, plan2.campaign.id, 'not-the-hash')).rejects.toMatchObject({ code: 'approval_invalidated' });
    const again = await h.fleet.approvalRequest(h.agent, plan2.campaign.id);
    expect(again.scope_hash).toBe(req.scope_hash);
    await h.fleet.approvalGrant(h.owner, plan2.campaign.id, again.scope_hash);
  });

  it('unapproved product facts block every target', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 2);
    const p = await h.fleet.productCreate(h.owner, { url: 'https://acme.example', name: 'Acme' });
    const plan = await h.fleet.campaignPlan(h.agent, { productId: p.id, minExecutableDestinations: 1 });
    expect(plan.counts.executable).toBe(0);
    expect(plan.targets[0]!.blockers).toContain('product_facts_unapproved');
  });

  it('dedupes by canonical product and listing group, not by wording or tracking params', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 2);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 2);
    await expect(h.fleet.productCreate(h.owner, { url: 'https://www.ACME.example/?utm_source=x' })).rejects.toMatchObject({ code: 'product_exists' });
    await h.fleet.productUpdate(h.owner, p.id, { tagline: 'Reworded pitch' });
    await h.fleet.productApproveFacts(h.owner, p.id);
    const again = await h.fleet.campaignPlan(h.agent, { productId: p.id, minExecutableDestinations: 1 });
    expect(again.counts.executable).toBe(0);
    expect(again.targets.every((t) => t.blockers.some((b) => b.startsWith('duplicate_existing_submission')))).toBe(true);
    // A mirror in the same listing group is not a second target either.
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(50, { listing_group: 'dest-0.example' }));
    const p2 = await approvedProduct(h.fleet, h.owner, 'https://beta.example');
    const plan2 = await h.fleet.campaignPlan(h.agent, { productId: p2.id, minExecutableDestinations: 1 });
    expect(plan2.counts.executable).toBe(2);
  });

  it('11, 12, 17, 20. report keeps states distinct, keeps failures in the denominator and unknowns unknown', async () => {
    let n = 0;
    const adapter = fakeAdapter('fake', {
      execute: async (ctx) => {
        n++;
        if (n === 1) return { kind: 'scheduled', remoteId: 'a', receiptId: 'ra', listingUrl: null, evidence: {} };
        if (n === 2) return { kind: 'needs_human', reasonCode: 'captcha', externalActionPerformed: false };
        if (n === 3) return { kind: 'failed', reasonCode: 'http_400', externalActionPerformed: false };
        return { kind: 'submitted', remoteId: ctx.intentId, receiptId: `r-${ctx.intentId}`, evidence: {} };
      },
    });
    h = await harness([adapter]);
    await seedDestinations(h.fleet, h.owner, 4);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 4);
    await h.fleet.worker().tick(10);
    const r = await h.fleet.reportGet(h.owner, plan.campaign.id);
    expect(r.outcomes).toEqual({ scheduled: 1, needs_human: 1, failed: 1, submitted: 1 });
    expect(r.outcomes.published_verified).toBeUndefined();
    expect(r.execution).toEqual({ attempted_denominator: 4, evidenced_receipts: 2, rate: 0.5 });
    expect(r.analytics.referral_visits).toBeNull();
    expect(r.human_effort_minutes).toBeNull();
    expect(r.limitations.join(' ')).toMatch(/unknown, not zero/);
    expect(r.costs.listing_spend_cents).toBe(0);

    await h.fleet.logEffort(h.owner, plan.campaign.id, 'copy review', 12.5);
    const md = await h.fleet.reportExport(h.owner, plan.campaign.id, 'markdown');
    expect(md).toContain('Human effort: 12.5 min');
    expect(md).toContain('Referral visits: unknown');
    const csv = await h.fleet.reportExport(h.owner, plan.campaign.id, 'csv');
    expect(csv.split('\n')[0]).toContain('receipt_id');
  });

  it('18. unsupported remote update/withdraw fail explicitly without remote action', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 1);
    await h.fleet.worker().tick();
    const [i] = await all<{ id: string }>(h.fleet.db, 'SELECT id FROM intents WHERE campaign_id = ?', plan.campaign.id);
    const res = await h.fleet.submissionWithdraw(h.owner, i!.id);
    expect(res).toMatchObject({ ok: false, reason_code: 'unsupported_operation', external_action_performed: false });
    expect(await h.fleet.submissionUpdate(h.owner, i!.id)).toMatchObject({ reason_code: 'unsupported_operation' });
  });
});
