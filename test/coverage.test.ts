import { afterEach, describe, expect, it } from 'vitest';
import { harness, qualifyingDestination, seedDestinations, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

describe('100+ destination release gate (PRD §4, §16 tests 1, 2, 4, 5, 19)', () => {
  it('1. five hundred imported names with 99 qualifying adapters fail release', async () => {
    h = await harness();
    const records = Array.from({ length: 500 }, (_, i) => ({ name: `Dir ${i}`, url: `https://imported-${i}.example/submit`, kind: 'directory', labeled_free: true }));
    const imp = await h.fleet.catalogImport(h.owner, records, 'awesome-submitlist', 'CC0-1.0');
    expect(imp.created).toBe(500);
    await seedDestinations(h.fleet, h.owner, 99);
    const cov = await h.fleet.coverageReport();
    expect(cov.discovered).toBe(599);
    expect(cov.source_labeled_free).toBe(599);
    expect(cov.verified_free).toBe(99);
    expect(cov.release_qualifying).toBe(99);
    expect(cov.status).toBe('below_minimum');

    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(99));
    const cov2 = await h.fleet.coverageReport();
    expect(cov2.release_qualifying).toBe(100);
    expect(cov2.status).toBe('release_ready');
  });

  it('imports never enable execution, even when the import claims everything', async () => {
    h = await harness();
    await h.fleet.catalogImport(h.owner, [{ name: 'X', url: 'https://x.example', kind: 'launch', labeled_free: true }], 's', 'MIT');
    const d = await h.fleet.catalogGet('x-example');
    expect(d.fee_status).toBe('source_labeled_free');
    expect(d.automation_permission).toBe('unknown');
    expect(d.adapter_id).toBeNull();
    expect(d.qualification.stages.release_qualifying).toBe(false);
    // Re-import cannot overwrite reviewed facts.
    await h.fleet.catalogUpsert(h.owner, { ...qualifyingDestination(0), slug: 'x-example', canonical_domain: 'x.example', listing_group: 'x.example' });
    await h.fleet.catalogImport(h.owner, [{ name: 'X', url: 'https://x.example' }], 's', 'MIT');
    expect((await h.fleet.catalogGet('x-example')).qualification.stages.release_qualifying).toBe(true);
  });

  it('2. aliases, syndication, assisted workflows and non-directory channels never inflate coverage', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 3);
    // Mirror / language path of dest-0: same independent listing group.
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(100, { listing_group: 'dest-0.example', canonical_domain: 'de.dest-0.example' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(101, { automation_method: 'assisted' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(102, { challenge_policy: 'always' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(103, { kind: 'social' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(104, { kind: 'newsletter' }));
    const cov = await h.fleet.coverageReport();
    expect(cov.release_qualifying).toBe(3);
  });

  it('4. every counted adapter has live evidence, contract tests and an installed adapter', async () => {
    h = await harness();
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { live_evidence_ref: null }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(1, { contract_tested_at: null }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(2, { adapter_id: 'not-installed' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(3, { reconcile_support: 'none' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(4));
    const cov = await h.fleet.coverageReport();
    expect(cov.release_qualifying).toBe(1);
    expect(cov.blocker_counts.no_live_submission_evidence).toBe(1);
    expect(cov.blocker_counts.no_contract_tests).toBe(1);
    expect(cov.blocker_counts.adapter_not_installed).toBe(1);
    expect(cov.blocker_counts.no_reconcile).toBe(1);
  });

  it('5. paid, conditional, stale, permission-less and backlink routes are excluded', async () => {
    h = await harness();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { fee_status: 'paid' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(1, { fee_status: 'conditional_free' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(2, { fee_checked_at: old }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(3, { automation_permission: 'unknown' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(4, { backlink_required: true }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(5, { automation_permission: 'denied' }));
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(6, { quality_decision: 'rejected' }));
    const cov = await h.fleet.coverageReport();
    expect(cov.release_qualifying).toBe(0);
    for (const b of ['paid_route', 'conditional_free', 'fee_evidence_stale', 'automation_permission_unknown', 'backlink_required', 'automation_denied', 'quality_rejected']) {
      expect(cov.blocker_counts[b], b).toBe(1);
    }
  });

  it('19. a broken or newly paid adapter reduces live coverage immediately', async () => {
    h = await harness();
    await seedDestinations(h.fleet, h.owner, 100);
    expect((await h.fleet.coverageReport()).status).toBe('release_ready');
    await h.fleet.catalogSetHealth(h.owner, 'dest-5', 'quarantined', 'form changed');
    await h.fleet.catalogUpsert(h.owner, { ...qualifyingDestination(6), fee_status: 'paid' });
    const cov = await h.fleet.coverageReport();
    expect(cov.release_qualifying).toBe(98);
    expect(cov.status).toBe('below_minimum');
  });

  it('registry edits are owner-only', async () => {
    h = await harness();
    await expect(h.fleet.catalogUpsert(h.agent, qualifyingDestination(0))).rejects.toMatchObject({ code: 'owner_required' });
    await expect(h.fleet.catalogImport(h.agent, [], 's', 'l')).rejects.toMatchObject({ code: 'owner_required' });
  });
});
