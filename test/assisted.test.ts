import { afterEach, describe, expect, it } from 'vitest';
import { fit } from '../src/assisted.js';
import { all } from '../src/db.js';
import { fakeAdapter, harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

async function product() {
  const p = await h.fleet.productCreate(h.owner, {
    url: 'https://acme.example/',
    name: 'Acme',
    tagline: 'The friendly to-do app for small teams',
    description: 'Acme keeps a small team on one list. It syncs across devices, works offline and costs nothing for up to five people. Built by two developers who were tired of heavyweight project tools.',
    categories: ['productivity', 'saas'],
    contact_email: 'hello@acme.example',
    logo_path: 'logo.png',
    facts: { pricing_model: 'Freemium', x: '@acme' },
  });
  return h.fleet.productApproveFacts(h.owner, p.id);
}

describe('bundled catalog', () => {
  it('imports the curated catalog idempotently without enabling automation', async () => {
    h = await harness([fakeAdapter()]);
    const first = await h.fleet.loadBundledCatalog();
    expect(first.created + first.updated).toBe(339);
    const again = await h.fleet.loadBundledCatalog();
    expect(again.created).toBe(0);
    expect(again.updated).toBe(first.created + first.updated);
    const stats = await h.fleet.catalogStats();
    expect(stats.total).toBe(first.created);
    expect(stats.free).toBeGreaterThan(150);
    expect(stats.by_channel.directory).toBeGreaterThan(50);
    expect(stats.automated).toBe(0);
    const cov = await h.fleet.coverageReport();
    expect(cov.release_qualifying).toBe(0);
  });
});

describe('assisted submissions', () => {
  it('plans free directories and launch sites as assisted targets and never paid ones', async () => {
    h = await harness([fakeAdapter()]);
    await h.fleet.loadBundledCatalog();
    const p = await product();
    const plan = await h.fleet.campaignPlan(h.agent, { productId: p.id });
    expect(plan.campaign.status).toBe('draft');
    expect(plan.counts.assisted).toBeGreaterThan(50);
    expect(plan.counts.auto).toBe(0);
    const chosen = new Set(plan.targets.filter((t) => t.executable).map((t) => t.destination));
    const ds = await h.fleet.catalogSearch(undefined, 1000);
    for (const d of ds.filter((x) => chosen.has(x.slug))) {
      expect(['source_labeled_free', 'verified_free']).toContain(d.fee_status);
      expect(['directory', 'product-launch-site']).toContain(d.channel);
    }
    const paid = ds.find((d) => d.fee_status === 'paid' && d.channel === 'directory');
    if (paid) expect(plan.targets.find((t) => t.destination === paid.slug)?.blockers).toContain('paid_route');

    const strict = await h.fleet.campaignPlan(h.agent, { productId: p.id, mode: 'auto_only' });
    expect(strict.campaign.status).toBe('coverage_insufficient');
    expect(strict.counts.executable).toBe(0);
  });

  it('works an assisted submission end to end: kit, submitted, live; workers never touch it', async () => {
    const adapter = fakeAdapter();
    h = await harness([adapter]);
    await h.fleet.loadBundledCatalog();
    const p = await product();
    const directory = (await h.fleet.catalogSearch(undefined, 1000)).find((d) => d.channel === 'directory' && d.fee_status === 'source_labeled_free')!;
    const plan = await h.fleet.campaignPlan(h.agent, { productId: p.id, destinations: [directory.slug] });
    expect(plan.counts).toMatchObject({ executable: 1, assisted: 1 });
    await h.fleet.approvalRequest(h.agent, plan.campaign.id);
    await h.fleet.approvalGrant(h.owner, plan.campaign.id);
    await h.fleet.campaignRun(h.owner, plan.campaign.id);
    await h.fleet.worker().tick(10);
    expect(adapter.calls.execute).toHaveLength(0);

    const [q] = await h.fleet.campaignQueue(h.owner, plan.campaign.id);
    expect(q).toMatchObject({ state: 'needs_human', mode: 'assisted', reason_code: 'assisted', destination: directory.slug });
    const id = String(q!.id);

    const kit = await h.fleet.submissionKit(h.owner, id);
    expect(kit.destination.submit_url).toBe(directory.submission_url);
    const f = Object.fromEntries(kit.fields.map((x) => [x.key, x.value]));
    expect(f.name).toBe('Acme');
    expect(f.url).toBe('https://acme.example/');
    expect(f.short_description!.length).toBeLessThanOrEqual(160);
    expect(f['fact.pricing_model']).toBe('Freemium');
    expect(f.logo).toMatch(/\/p\/prd_.+\/logo$/);

    await expect(h.fleet.submissionRequeue(h.owner, id)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(h.fleet.submissionMark(h.agent, id, 'submitted')).rejects.toMatchObject({ code: 'owner_required' });
    await expect(h.fleet.submissionMark(h.owner, id, 'live', { listing_url: 'https://x.example' })).rejects.toMatchObject({ code: 'invalid_state' });
    expect(await h.fleet.submissionMark(h.owner, id, 'submitted', { note: 'free tier' })).toMatchObject({ ok: true, state: 'submitted' });
    await expect(h.fleet.submissionMark(h.owner, id, 'live')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(h.fleet.submissionMark(h.owner, id, 'live', { listing_url: 'javascript:alert(1)' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await h.fleet.submissionMark(h.owner, id, 'live', { listing_url: 'https://dir.example/acme' })).toMatchObject({ state: 'published_verified' });

    const r = await h.fleet.reportGet(h.owner, plan.campaign.id);
    expect(r.outcomes).toEqual({ published_verified: 1 });
    expect(r.submissions[0]).toMatchObject({ listing_url: 'https://dir.example/acme' });
    const ev = await all<{ data_json: string }>(h.fleet.db, "SELECT data_json FROM intent_events WHERE intent_id = ? AND to_state = 'published_verified'", id);
    expect(JSON.parse(ev[0]!.data_json).evidence.by).toBe('owner');
  });

  it('skipping releases the duplicate slot so the destination can be planned again', async () => {
    h = await harness([fakeAdapter()]);
    await h.fleet.loadBundledCatalog();
    const p = await product();
    const directory = (await h.fleet.catalogSearch(undefined, 1000)).find((d) => d.channel === 'directory' && d.fee_status === 'source_labeled_free')!;
    const plan = await h.fleet.campaignPlan(h.agent, { productId: p.id, destinations: [directory.slug] });
    await h.fleet.approvalRequest(h.agent, plan.campaign.id);
    await h.fleet.approvalGrant(h.owner, plan.campaign.id);
    await h.fleet.campaignRun(h.owner, plan.campaign.id);
    const [q] = await h.fleet.campaignQueue(h.owner, plan.campaign.id);
    expect(await h.fleet.submissionMark(h.owner, String(q!.id), 'skipped', { note: 'only paid listings now' })).toMatchObject({ state: 'failed' });
    const again = await h.fleet.campaignPlan(h.agent, { productId: p.id, destinations: [directory.slug] });
    expect(again.counts.executable).toBe(1);
  });

  it('fit() trims at a boundary', () => {
    expect(fit('One. Two three four five six seven.', 12)).toBe('One. Two…');
    expect(fit('short', 10)).toBe('short');
  });
});
