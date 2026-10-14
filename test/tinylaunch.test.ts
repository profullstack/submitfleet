import { describe, expect, it } from 'vitest';
import { tinyLaunchAdapter, toDescriptionHtml, TINYLAUNCH_BASE } from '../src/adapters/tinylaunch.js';
import type { ExecContext } from '../src/adapters/types.js';
import type { Destination } from '../src/catalog.js';
import type { Product } from '../src/products.js';

// Contract tests against the request/response shapes in https://www.tinylaunch.com/llms.txt.
// These prove the adapter speaks the documented contract; they are not live evidence.

const product: Product = {
  id: 'prd_1', workspace_id: 'w', canonical_key: 'acme.example', url: 'https://acme.example/', name: 'Acme', tagline: 'The friendly to-do app',
  description: 'A friendly to-do app.\n\nFree <forever>.', categories: [], contact_email: null, logo_path: 'logo.png', facts: {},
  destination_fields: { tinylaunch: { category_id: 9 } }, approved_at: 'x', approved_by: 'o', created_at: 'x', updated_at: 'x',
};
const destination = { slug: 'tinylaunch', canonical_domain: 'tinylaunch.com' } as Destination;

type Call = { method: string; url: string; body: Record<string, unknown> | null; auth: string | null };

function mockFetch(routes: Record<string, (body: Record<string, unknown> | null, n: number) => [number, unknown]>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body, auth: headers.authorization ?? null });
    const key = `${method} ${url.replace(TINYLAUNCH_BASE, '').replace(/\?.*$/, '')}`;
    const h = routes[key];
    counts[key] = (counts[key] ?? 0) + 1;
    if (!h) return new Response(JSON.stringify({ error: 'unmocked' }), { status: 599 });
    const [status, json] = h(body, counts[key]!);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

async function prepared() {
  const a = tinyLaunchAdapter();
  return a.prepare({ product, destination, earliestDate: '2026-11-01', latestDate: '2026-11-30', readAsset: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
}

function ctx(f: typeof fetch, payload: Record<string, unknown>, refs: Record<string, unknown> = {}): ExecContext & { recorded: Record<string, unknown> } {
  const recorded: Record<string, unknown> = { ...refs };
  return {
    intentId: 'int_1',
    payload,
    destination,
    remoteRefs: refs,
    recorded,
    recordRemote: async (r) => void Object.assign(recorded, r),
    credentials: async () => ({ access_token: 'tok', expires_at_ms: String(Date.now() + 3_600_000) }),
    fetch: f,
    signal: new AbortController().signal,
    now: Date.now,
  };
}

const okRoutes = {
  'GET /maker': () => [200, { handle: 'acme_maker' }] as [number, unknown],
  'POST /startups': () => [201, { id: 16320, slug: 'acme' }] as [number, unknown],
  'GET /launch-dates': () =>
    [200, { windows: [
      { date: '2026-10-30', bookable_free: true },
      { date: '2026-11-02', bookable_free: false, bookable_premium: true },
      { date: '2026-11-03', bookable_free: true },
      { date: '2026-11-04', bookable_free: true },
    ], next_offset: null }] as [number, unknown],
};

describe('TinyLaunch adapter contract', () => {
  it('validate asks for missing facts instead of guessing them', () => {
    const issues = tinyLaunchAdapter().validate({ ...product, destination_fields: {}, tagline: null }, destination);
    expect(issues.map((i) => i.field).sort()).toEqual(['destination_fields.tinylaunch.category_id', 'tagline']);
  });

  it('prepare builds the documented startup shape without any network call', async () => {
    const p = (await prepared()) as { startup: Record<string, unknown> };
    expect(Object.keys(p.startup).sort()).toEqual(['category_id', 'description', 'logo', 'name', 'tagline', 'url']);
    expect(Object.keys(p.startup.logo as object).sort()).toEqual(['content_base64', 'filename']);
    expect(p.startup.description).toBe('<p>A friendly to-do app.</p><p>Free &lt;forever&gt;.</p>');
  });

  it('schedules a free launch: startup_id + date only, never premium or a paid tier', async () => {
    const { f, calls } = mockFetch({ ...okRoutes, 'POST /launches': () => [201, { id: 15213, startup_id: 16320, date: '2026-11-03', premium: false }] });
    const c = ctx(f, await prepared());
    const r = await tinyLaunchAdapter().execute(c);
    expect(r).toMatchObject({ kind: 'scheduled', remoteId: '15213', receiptId: 'tinylaunch:launch:15213', listingUrl: 'https://www.tinylaunch.com/launch/15213' });
    const launch = calls.find((x) => x.method === 'POST' && x.url.endsWith('/launches'))!;
    expect(launch.body).toEqual({ startup_id: 16320, date: '2026-11-03' });
    expect(launch.auth).toBe('Bearer tok');
    expect(calls.find((x) => x.url.includes('/launch-dates'))!.auth).toBeNull();
    expect(c.recorded).toMatchObject({ startup_id: 16320, launch_id: '15213' });
  });

  it('stops for a human if the response carries a payment link', async () => {
    const { f } = mockFetch({ ...okRoutes, 'POST /launches': () => [201, { id: 1, paid: false, premium: true, payment_url: 'https://checkout.example' }] });
    const r = await tinyLaunchAdapter().execute(ctx(f, await prepared()));
    expect(r).toMatchObject({ kind: 'needs_human', reasonCode: 'unexpected_payment:payment_url_returned', externalActionPerformed: true });
  });

  it('moves to the next free date on date_full, within the approved window', async () => {
    const { f, calls } = mockFetch({ ...okRoutes, 'POST /launches': (_b, n) => (n === 1 ? [409, { error: 'date_full' }] : [201, { id: 7 }]) });
    const r = await tinyLaunchAdapter().execute(ctx(f, await prepared()));
    expect(r.kind).toBe('scheduled');
    expect(calls.filter((x) => x.url.endsWith('/launches')).map((x) => x.body!.date)).toEqual(['2026-11-03', '2026-11-04']);
  });

  it('reuses a startup created by an earlier attempt instead of creating a duplicate', async () => {
    const { f, calls } = mockFetch({ ...okRoutes, 'POST /launches': () => [201, { id: 8 }] });
    await tinyLaunchAdapter().execute(ctx(f, await prepared(), { startup_id: 999 }));
    expect(calls.some((x) => x.url.endsWith('/startups'))).toBe(false);
    expect(calls.find((x) => x.url.endsWith('/launches'))!.body).toEqual({ startup_id: 999, date: '2026-11-03' });
  });

  it('server errors after a write are uncertain; a missing maker profile is a handoff', async () => {
    const e = mockFetch({ ...okRoutes, 'POST /launches': () => [502, {}] });
    expect((await tinyLaunchAdapter().execute(ctx(e.f, await prepared()))).kind).toBe('uncertain');
    const m = mockFetch({ ...okRoutes, 'GET /maker': () => [404, { error: 'not_found' }] });
    expect(await tinyLaunchAdapter().execute(ctx(m.f, await prepared()))).toMatchObject({ kind: 'needs_human', reasonCode: 'maker_profile_missing', externalActionPerformed: false });
  });

  it('reconcile reports absence only when no startup exists for the URL', async () => {
    const none = mockFetch({ 'GET /startups': () => [200, [{ id: 1, url: 'https://other.example/' }]] });
    expect((await tinyLaunchAdapter().reconcile(ctx(none.f, await prepared()))).status).toBe('absent');
    const some = mockFetch({ 'GET /startups': () => [200, [{ id: 2, url: 'https://acme.example' }]] });
    expect(await tinyLaunchAdapter().reconcile(ctx(some.f, await prepared()))).toMatchObject({ status: 'unknown', reasonCode: 'startup_found_launch_unknown' });
  });

  it('description HTML escapes everything', () => {
    expect(toDescriptionHtml('<script>x</script>')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
  });
});
