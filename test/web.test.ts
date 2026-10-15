import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimits } from '../src/auth.js';
import { buildApp } from '../src/http.js';
import type { Mail } from '../src/mail.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
let mails: Mail[];
let app: ReturnType<typeof buildApp>;
const ORIGIN = 'http://localhost';

beforeEach(async () => {
  resetRateLimits();
  h = await harness();
  await h.fleet.loadBundledCatalog();
  mails = [];
  app = buildApp(h.fleet, { mailer: async (m) => void mails.push(m), publicOrigin: ORIGIN });
});
afterEach(() => h?.cleanup());

const jar = new Map<string, string>();
function cookies(res: Response) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(';');
    const [k, v] = kv!.split('=');
    if (v) jar.set(k!, v);
    else jar.delete(k!);
  }
}
async function req(method: string, path: string, body?: unknown, opts: { origin?: string | null; cookie?: boolean; form?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie !== false && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = opts.form ? 'application/x-www-form-urlencoded' : 'application/json';
    payload = opts.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
  }
  const res = await app.request(path, { method, headers, body: payload, redirect: 'manual' });
  cookies(res);
  return res;
}
const tokenFrom = (m: Mail) => /#t=([\w-]+)/.exec(m.text)![1]!;

describe('pages', () => {
  it('landing shows the live catalog counts and strict CSP', async () => {
    const res = await req('GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    // no-referrer makes browsers send Origin: null on same-site form posts, which breaks the consent form.
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const html = await res.text();
    expect(html).not.toContain('{{');
    expect(html).toMatch(/<b>339<\/b><span>destinations in the catalog/);
  });

  it('the app redirects to sign-in when signed out, and pages carry no inline script or style', async () => {
    jar.clear();
    const res = await req('GET', '/app/products');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=%2Fapp%2Fproducts');
    for (const p of ['/', '/login', '/signup', '/auth/link', '/docs']) {
      const html = await (await req('GET', p)).text();
      expect(html, p).not.toMatch(/<script>(?!<\/)/);
      expect(html, p).not.toMatch(/\sstyle="/);
      expect(html, p).not.toMatch(/\son\w+="/);
    }
    expect((await req('GET', '/assets/app.js')).status).toBe(200);
    expect((await req('GET', '/assets/../package.json')).status).toBe(404);
  });
});

describe('accounts', () => {
  it('signs up through the emailed link only, then signs in with the password', async () => {
    jar.clear();
    const r = await req('POST', '/api/auth/signup', { email: 'Ann@Example.com', password: 'correct horse battery', name: 'Ann' });
    expect(r.status).toBe(200);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('ann@example.com');
    expect(mails[0]!.subject).toMatch(/Confirm/);
    // No account (and no session) until the link is used.
    expect((await req('GET', '/api/me')).status).toBe(401);
    const link = await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    expect(await link.json()).toMatchObject({ ok: true, created: true });
    const me = await (await req('GET', '/api/me')).json();
    expect(me).toMatchObject({ role: 'owner', user: { email: 'ann@example.com', name: 'Ann' }, has_password: true });
    expect((await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) })).status).toBe(400);

    await req('POST', '/api/auth/logout', {});
    expect((await req('GET', '/api/me')).status).toBe(401);
    expect((await req('POST', '/api/auth/login', { email: 'ann@example.com', password: 'wrong password!!' })).status).toBe(401);
    expect((await req('POST', '/api/auth/login', { email: 'ann@example.com', password: 'correct horse battery' })).status).toBe(200);
    expect((await req('GET', '/app')).status).toBe(200);
  });

  it('never reveals whether an address has an account', async () => {
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'new@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    jar.clear();
    const a = await (await req('POST', '/api/auth/signup', { email: 'new@example.com', password: 'another password 1' })).json();
    const b = await (await req('POST', '/api/auth/signup', { email: 'nobody@example.com', password: 'another password 1' })).json();
    expect(a).toEqual(b);
    // The existing account got a plain sign-in link; its (absent) password was not set by the sign-up attempt.
    expect(mails[1]!.subject).toMatch(/sign-in link/);
    const l1 = await (await req('POST', '/api/auth/login', { email: 'new@example.com', password: 'another password 1' })).json();
    const l2 = await (await req('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'another password 1' })).json();
    expect(l1).toEqual(l2);
  });

  it('locks password sign-in after ten failures but the emailed link still works', async () => {
    jar.clear();
    await req('POST', '/api/auth/signup', { email: 'lock@example.com', password: 'the real password' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    jar.clear();
    for (let i = 0; i < 10; i++) await req('POST', '/api/auth/login', { email: 'lock@example.com', password: `nope nope ${i}` });
    const locked = await req('POST', '/api/auth/login', { email: 'lock@example.com', password: 'the real password' });
    expect(locked.status).toBe(429);
    await req('POST', '/api/auth/magic', { email: 'lock@example.com' });
    expect((await req('POST', '/api/auth/link', { token: tokenFrom(mails[1]!) })).status).toBe(200);
  });

  it('refuses cookie-authenticated writes without our Origin (CSRF)', async () => {
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'csrf@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    expect((await req('POST', '/api/v1/products', { url: 'https://a.example', name: 'A' }, { origin: null })).status).toBe(403);
    expect((await req('POST', '/api/v1/products', { url: 'https://a.example', name: 'A' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await req('POST', '/api/v1/products', { url: 'https://a.example', name: 'A' })).status).toBe(201);
    expect((await req('POST', '/api/auth/magic', { email: 'x@example.com' }, { origin: null })).status).toBe(403);
  });

  it('each account gets its own workspace', async () => {
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'one@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    const p = await (await req('POST', '/api/v1/products', { url: 'https://one.example', name: 'One' })).json();
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'two@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[1]!) });
    expect(await (await req('GET', '/api/v1/products')).json()).toEqual([]);
    expect((await req('GET', `/api/v1/products/${p.id}`)).status).toBe(404);
  });
});

describe('OAuth 2.1 for the CLI', () => {
  async function signedIn() {
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'cli@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails.at(-1)!) });
  }
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'http://127.0.0.1:53111/callback';
  const q = new URLSearchParams({ response_type: 'code', client_id: 'submitfleet-cli', redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });

  it('code + PKCE, rotating refresh, and reuse revokes the family', async () => {
    jar.clear();
    const anon = await req('GET', `/oauth/authorize?${q}`);
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toMatch(/^\/login\?next=/);
    await signedIn();
    const consent = await req('GET', `/oauth/authorize?${q}`);
    expect(await consent.text()).toContain('Allow SubmitFleet CLI?');
    const allow = await req('POST', '/oauth/authorize', { client_id: 'submitfleet-cli', redirect_uri: redirect, code_challenge: challenge, state: 'xyz', decision: 'allow' }, { form: true });
    const loc = new URL(allow.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code')!;

    const bad = await req('POST', '/oauth/token', { grant_type: 'authorization_code', code, client_id: 'submitfleet-cli', redirect_uri: redirect, code_verifier: 'wrong'.padEnd(43, 'x') }, { form: true, cookie: false, origin: null });
    expect(bad.status).toBe(400);
    // The failed attempt spent the code: a code is single-use even when the verifier was wrong.
    const again = await req('POST', '/oauth/token', { grant_type: 'authorization_code', code, client_id: 'submitfleet-cli', redirect_uri: redirect, code_verifier: verifier }, { form: true, cookie: false, origin: null });
    expect(again.status).toBe(400);

    const allow2 = await req('POST', '/oauth/authorize', { client_id: 'submitfleet-cli', redirect_uri: redirect, code_challenge: challenge, state: 's2', decision: 'allow' }, { form: true });
    const code2 = new URL(allow2.headers.get('location')!).searchParams.get('code')!;
    const t1 = await (await req('POST', '/oauth/token', { grant_type: 'authorization_code', code: code2, client_id: 'submitfleet-cli', redirect_uri: redirect, code_verifier: verifier }, { form: true, cookie: false, origin: null })).json();
    expect(t1.token_type).toBe('Bearer');
    const me = await app.request('/api/me', { headers: { authorization: `Bearer ${t1.access_token}` } });
    expect(await me.json()).toMatchObject({ role: 'owner', user: { email: 'cli@example.com' } });

    const t2 = await (await req('POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: 'submitfleet-cli' }, { form: true, cookie: false, origin: null })).json();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    // Replaying the spent refresh token revokes everything issued from this sign-in.
    expect((await req('POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: 'submitfleet-cli' }, { form: true, cookie: false, origin: null })).status).toBe(400);
    expect((await app.request('/api/me', { headers: { authorization: `Bearer ${t2.access_token}` } })).status).toBe(401);
    expect((await req('POST', '/oauth/token', { grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: 'submitfleet-cli' }, { form: true, cookie: false, origin: null })).status).toBe(400);
  });

  it('rejects non-loopback redirects and missing PKCE; denial returns access_denied', async () => {
    await signedIn();
    const evil = new URLSearchParams(q);
    evil.set('redirect_uri', 'https://evil.example/cb');
    expect((await req('GET', `/oauth/authorize?${evil}`)).status).toBe(400);
    const nopkce = new URLSearchParams(q);
    nopkce.delete('code_challenge');
    expect((await req('GET', `/oauth/authorize?${nopkce}`)).status).toBe(400);
    const deny = await req('POST', '/oauth/authorize', { client_id: 'submitfleet-cli', redirect_uri: redirect, code_challenge: challenge, state: 'z', decision: 'deny' }, { form: true });
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    const meta = await (await req('GET', '/.well-known/oauth-authorization-server')).json();
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });
});

describe('assisted flow over HTTP', () => {
  it('a signed-in owner adds a product, launches, and marks a submission', async () => {
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'flow@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    const p = await (await req('POST', '/api/v1/products', { url: 'https://flow.example', name: 'Flow', tagline: 'Flow state for teams', description: 'Flow helps teams focus.' })).json();
    expect((await req('POST', `/api/v1/products/${p.id}/approve-facts`, {})).status).toBe(200);
    const plan = await (await req('POST', '/api/v1/campaigns', { product_id: p.id })).json();
    expect(plan.counts.assisted).toBeGreaterThan(50);
    const r = await (await req('POST', `/api/v1/campaigns/${plan.campaign.id}/approval-request`, {})).json();
    expect((await req('POST', `/api/v1/campaigns/${plan.campaign.id}/approve`, { scope_hash: r.scope_hash })).status).toBe(200);
    expect((await req('POST', `/api/v1/campaigns/${plan.campaign.id}/run`, {})).status).toBe(200);
    const queue = await (await req('GET', `/api/v1/campaigns/${plan.campaign.id}/queue`)).json();
    expect(queue.length).toBe(plan.counts.assisted);
    const kit = await (await req('GET', `/api/v1/submissions/${queue[0].id}/kit`)).json();
    expect(kit.fields.find((f: { key: string }) => f.key === 'name').value).toBe('Flow');
    const marked = await (await req('POST', `/api/v1/submissions/${queue[0].id}/mark`, { action: 'submitted', listing_url: 'https://dir.example/flow' })).json();
    expect(marked.state).toBe('submitted');
  });

  it('logo upload checks the image signature and serves it publicly', async () => {
    jar.clear();
    await req('POST', '/api/auth/magic', { email: 'logo@example.com' });
    await req('POST', '/api/auth/link', { token: tokenFrom(mails[0]!) });
    const p = await (await req('POST', '/api/v1/products', { url: 'https://logo.example', name: 'Logo' })).json();
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const fake = await app.request(`/api/v1/products/${p.id}/logo`, { method: 'PUT', headers: { cookie, origin: ORIGIN, 'content-type': 'image/png' }, body: Buffer.from('<svg onload=alert(1)>') });
    expect(fake.status).toBe(400);
    const ok = await app.request(`/api/v1/products/${p.id}/logo`, { method: 'PUT', headers: { cookie, origin: ORIGIN, 'content-type': 'image/png' }, body: png });
    expect(ok.status).toBe(200);
    const pub = await app.request(`/p/${p.id}/logo`);
    expect(pub.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await pub.arrayBuffer()).equals(png)).toBe(true);
  });
});

describe('fact extraction', () => {
  it('splits "Name: tagline" titles, prefers the domain name, and skips slogans as names', async () => {
    const { parseFacts } = await import('../src/extract.js');
    const a = parseFacts('<title>typeheard: drop a recording, get the transcript</title>', 'https://typeheard.com/');
    expect(a).toMatchObject({ name: 'typeheard', tagline: 'drop a recording, get the transcript' });
    const b = parseFacts('<meta property="og:site_name" content="Know before it drops"><title>Know before it drops</title><meta name="description" content="Follow a genre or a name and get told before it drops. Free.">', 'https://genrewatch.com/');
    expect(b.name).toBe('genrewatch');
    expect(b.tagline).toBe('Know before it drops');
    const c = parseFacts('<title>bl0ggers. | Human-in-the-loop AI publishing</title><link rel="icon" href="/i.svg"><link rel="apple-touch-icon" href="/a.png">', 'https://bl0ggers.com/');
    expect(c.name).toBe('bl0ggers');
    expect(c.icon_candidates[0]).toBe('https://bl0ggers.com/a.png');
    expect(c.icon_candidates.at(-1)).toBe('https://bl0ggers.com/i.svg');
  });
});
