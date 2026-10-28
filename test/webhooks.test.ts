import { afterEach, describe, expect, it } from 'vitest';
import { verifySignature, type CloudEvent } from '@profullstack/webhooks';
import { all } from '../src/db.js';
import { buildApp } from '../src/http.js';
import { createApiKey } from '../src/workspaces.js';
import { libsqlWebhookStore } from '../src/webhook-store.js';
import { approvedProduct, fakeAdapter, harness, launch, seedDestinations, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

interface Received {
  url: string;
  headers: Headers;
  body: string;
  event: CloudEvent<Record<string, unknown>>;
}

/** A unit-test receiver: every delivery lands here, nothing leaves the process. */
function receiver(status = 200) {
  const got: Received[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    got.push({ url: String(url), headers: new Headers(init?.headers as HeadersInit), body, event: JSON.parse(body) });
    return new Response('ok', { status });
  }) as typeof fetch;
  return { got, fetchImpl };
}

const publicDns = { lookup: async () => ['93.184.216.34'] };

async function setup(status = 200) {
  const r = receiver(status);
  h = await harness([fakeAdapter()], { webhooks: { fetch: r.fetchImpl, guard: publicDns }, publicOrigin: 'https://submitfleet.com' });
  return r;
}

const types = (got: Received[]) => got.map((g) => g.event.type);

describe('webhooks: libSQL store', () => {
  it('stores endpoints sealed at rest, leases due deliveries once, and prunes', async () => {
    await setup();
    const { endpoint, secret } = await h.fleet.webhookCreate(h.owner, { url: 'https://hooks.example/sf', events: ['submission.*'] });
    expect(secret).toMatch(/^whsec_/);
    const [row] = await all<{ secret: string; events: string; owner: string }>(h.fleet.db, 'SELECT secret, events, owner FROM webhook_endpoints');
    expect(row!.secret.startsWith('v1.')).toBe(true);
    expect(row!.secret).not.toContain(secret);
    expect(row!.owner).toBe(h.owner.workspaceId);
    expect(JSON.parse(row!.events)).toEqual(['submission.*']);

    const store = libsqlWebhookStore(h.fleet.db);
    const now = Date.now();
    await store.insertDeliveries([
      { id: 'd1', endpointId: endpoint.id, owner: h.owner.workspaceId, eventId: 'e1', eventType: 'submission.submitted', payload: '{}', status: 'pending', attempts: 0, nextAt: now - 1, lastStatus: null, lastError: null, createdAt: now, updatedAt: now },
      { id: 'd2', endpointId: endpoint.id, owner: h.owner.workspaceId, eventId: 'e2', eventType: 'submission.submitted', payload: '{}', status: 'pending', attempts: 0, nextAt: now + 60_000, lastStatus: null, lastError: null, createdAt: now, updatedAt: now },
    ]);
    const first = await store.claimDue(now, 10, 30_000);
    expect(first.map((d) => d.id)).toEqual(['d1']);
    expect(await store.claimDue(now, 10, 30_000)).toEqual([]);
    await store.updateDelivery('d1', { status: 'delivered', attempts: 1, lastStatus: 200, updatedAt: now - 10 });
    expect(await store.getDelivery('d1')).toMatchObject({ status: 'delivered', attempts: 1, lastStatus: 200 });
    await store.prune(now);
    expect(await store.getDelivery('d1')).toBeNull();
    expect(await store.getDelivery('d2')).not.toBeNull();
    await store.deleteEndpoint(endpoint.id);
    expect(await store.listEndpoints(h.owner.workspaceId)).toEqual([]);
    expect(await store.getDelivery('d2')).toBeNull();
  });
});

describe('webhooks: events', () => {
  it('emits campaign and submission events to subscribed endpoints, signed with the endpoint secret', async () => {
    const r = await setup();
    const all_ = await h.fleet.webhookCreate(h.owner, { url: 'https://hooks.example/all' });
    await h.fleet.webhookCreate(h.owner, { url: 'https://hooks.example/live-only', events: ['submission.published'] });
    await seedDestinations(h.fleet, h.owner, 2);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 2);
    await h.fleet.worker().tick();
    for (const q of await h.fleet.campaignQueue(h.owner, plan.campaign.id)) {
      await h.fleet.submissionMark(h.owner, q.id, 'live', { listing_url: 'https://dest.example/acme' });
    }
    expect((await h.fleet.campaignStatus(h.owner, plan.campaign.id)).campaign.status).toBe('completed');
    await h.fleet.hooks.drain();

    const toAll = r.got.filter((g) => g.url.endsWith('/all'));
    expect(types(toAll).sort()).toEqual(['campaign.completed', 'campaign.started', 'submission.published', 'submission.published', 'submission.submitted', 'submission.submitted'].sort());
    expect(types(r.got.filter((g) => g.url.endsWith('/live-only')))).toEqual(['submission.published', 'submission.published']);

    const started = toAll.find((g) => g.event.type === 'campaign.started')!;
    expect(started.event).toMatchObject({ specversion: '1.0', source: 'https://submitfleet.com', subject: plan.campaign.id, data: { campaign_id: plan.campaign.id, product_id: p.id, status: 'running', queued: 2 } });
    const live = toAll.find((g) => g.event.type === 'submission.published')!;
    expect(live.event.data).toMatchObject({ campaign_id: plan.campaign.id, from: 'submitted', state: 'published_verified', listing_url: 'https://dest.example/acme', reason_code: 'owner_confirmed_live' });
    expect(live.event.data.destination).toMatch(/^dest-\d$/);
    for (const g of toAll) expect(verifySignature({ headers: g.headers, body: g.body, secret: all_.secret })).toMatchObject({ ok: true });
  });

  it('emits paused, resumed and canceled, and nothing for another workspace', async () => {
    const r = await setup();
    await h.fleet.webhookCreate(h.owner, { url: 'https://hooks.example/c', events: ['campaign.*'] });
    await seedDestinations(h.fleet, h.owner, 2);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 2);
    await h.fleet.campaignPause(h.owner, plan.campaign.id);
    await h.fleet.campaignRun(h.owner, plan.campaign.id);
    await h.fleet.campaignCancel(h.owner, plan.campaign.id);
    await h.fleet.hooks.drain();
    expect(types(r.got)).toEqual(['campaign.started', 'campaign.paused', 'campaign.resumed', 'campaign.canceled']);
    expect(r.got[3]!.event.data).toMatchObject({ status: 'canceled', canceled: 2 });
  });

  it('a receiver failure never fails the action and is retried later', async () => {
    const r = await setup(500);
    await h.fleet.webhookCreate(h.owner, { url: 'https://hooks.example/down' });
    await seedDestinations(h.fleet, h.owner, 1);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 1);
    expect((await h.fleet.campaignStatus(h.owner, plan.campaign.id)).campaign.status).toBe('running');
    await h.fleet.hooks.drain();
    expect(r.got).toHaveLength(1);
    const [d] = await h.fleet.webhookDeliveries(h.owner);
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status: 500 });
  });

  it('webhook management is owner only', async () => {
    await setup();
    await expect(h.fleet.webhookList(h.agent)).rejects.toMatchObject({ code: 'owner_required' });
    await expect(h.fleet.webhookCreate(h.owner, { url: 'http://hooks.example/x' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(h.fleet.webhookCreate(h.owner, { url: 'https://hooks.example/x', events: ['nope.happened'] })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(h.fleet.webhookTest(h.owner, 'wh_missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('webhooks: HTTP API', () => {
  it('mounts /api/v1/webhooks behind API-key auth, owner keys only', async () => {
    const r = await setup();
    const app = buildApp(h.fleet, { crawlGate: null });
    const owner = (await createApiKey(h.fleet.db, h.owner.workspaceId, 'owner', 'o')).token;
    const agent = (await createApiKey(h.fleet.db, h.owner.workspaceId, 'agent', 'a')).token;
    const call = (token: string | null, method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

    expect((await call(null, 'GET', '/api/v1/webhooks')).status).toBe(401);
    expect((await call(agent, 'GET', '/api/v1/webhooks')).status).toBe(403);
    const created = await call(owner, 'POST', '/api/v1/webhooks', { url: 'https://hooks.example/api', events: ['campaign.started'] });
    expect(created.status).toBe(201);
    const { endpoint, secret } = (await created.json()) as { endpoint: { id: string }; secret: string };
    const list = (await (await call(owner, 'GET', '/api/v1/webhooks')).json()) as { endpoints: unknown[]; event_types: string[] };
    expect(list.endpoints).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list.event_types).toContain('submission.published');
    const test = (await (await call(owner, 'POST', `/api/v1/webhooks/${endpoint.id}/test`)).json()) as { ok: boolean };
    expect(test.ok).toBe(true);
    expect(r.got.at(-1)!.event.type).toBe('webhook.test');
    expect(verifySignature({ headers: r.got.at(-1)!.headers, body: r.got.at(-1)!.body, secret })).toMatchObject({ ok: true });
    const rotated = (await (await call(owner, 'POST', `/api/v1/webhooks/${endpoint.id}/rotate`)).json()) as { secret: string };
    expect(rotated.secret).not.toBe(secret);
    expect((await call(owner, 'DELETE', `/api/v1/webhooks/${endpoint.id}`)).status).toBe(200);
    expect((await call(owner, 'GET', `/api/v1/webhooks/${endpoint.id}`)).status).toBe(404);
  });
});
