import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimits } from '../src/auth.js';
import { createCrawlGate } from '../src/crawl-gate.js';
import { buildApp } from '../src/http.js';
import type { Mail } from '../src/mail.js';
import { bonusVerdict, canonicalMailbox } from '../src/rewards.js';
import { harness, type Harness } from './helpers.js';

process.env.PROFULLSTACK_FOOTER_OFFLINE ??= '1';

let h: Harness;
let mails: Mail[];
let app: ReturnType<typeof buildApp>;
const ORIGIN = 'http://localhost';

beforeEach(async () => {
  resetRateLimits();
  h = await harness();
  mails = [];
  app = buildApp(h.fleet, { mailer: async (m) => void mails.push(m), publicOrigin: ORIGIN });
});
afterEach(() => h?.cleanup());

/** One browser: its own cookie jar and network address. */
function browser(ip: string) {
  const jar = new Map<string, string>();
  return async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: ORIGIN, 'x-real-ip': ip };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const [k, v] = kv!.split('=');
      if (v) jar.set(k!, v);
      else jar.delete(k!);
    }
    return res;
  };
}
type Browser = ReturnType<typeof browser>;
const tokenFrom = (m: Mail) => /#t=([\w-]+)/.exec(m.text)![1]!;

async function signUp(b: Browser, email: string) {
  const n = mails.length;
  expect((await b('POST', '/api/auth/signup', { email, first_name: 'Test', last_name: 'Person' })).status).toBe(200);
  const mail = mails[n];
  expect(mail, `no mail for ${email}`).toBeTruthy();
  return mail!;
}
async function confirm(b: Browser, mail: Mail) {
  const r = await b('POST', '/api/auth/link', { token: tokenFrom(mail) });
  expect(r.status).toBe(200);
  return r.json();
}
async function makeInvite(b: Browser) {
  const r = await b('POST', '/api/v1/invites', { note: 'friend' });
  expect(r.status).toBe(201);
  return (await r.json()) as { code: string; id: string };
}

describe('credit codes', () => {
  it('a code grants Pro days through the plan, once per person, and refuses reuse', async () => {
    const ann = browser('10.0.0.1');
    await confirm(ann, await signUp(ann, 'ann@acme.io'));
    expect(await (await ann('GET', '/api/v1/plan')).json()).toMatchObject({ plan: 'free', pro_active: false });

    const minted = await h.fleet.rewards.mint({ days: 30, maxRedemptions: 2, label: 'test' });
    expect(minted.code).toMatch(/^SF-/);
    const ok = await ann('POST', '/api/v1/credits/redeem', { code: minted.code.toLowerCase().replaceAll('-', ' ') });
    expect(ok.status).toBe(200);
    const plan = await ok.json();
    expect(plan).toMatchObject({ ok: true, days: 30, plan: 'pro', pro_active: true, days_left: 30 });

    const again = await ann('POST', '/api/v1/credits/redeem', { code: minted.code });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'code_already_redeemed' });
    expect((await ann('POST', '/api/v1/credits/redeem', { code: 'SF-0000-0000-0000-0000' })).status).toBe(400);

    // A second code stacks onto the end of the first.
    const more = await h.fleet.rewards.mint({ days: 10 });
    expect(await (await ann('POST', '/api/v1/credits/redeem', { code: more.code })).json()).toMatchObject({ days_left: 40 });

    // Revoked codes stop working; a workspace API key has no plan.
    const dead = await h.fleet.rewards.mint({ days: 5 });
    await h.fleet.rewards.credits.revoke(dead.id);
    expect(await (await ann('POST', '/api/v1/credits/redeem', { code: dead.code })).json()).toMatchObject({ error: 'code_revoked' });
    const key = await app.request('/api/v1/plan', { headers: { authorization: `Bearer ${(await h.fleet.apiKeyCreate(h.owner, 'owner', 'k')).token}` } });
    expect(key.status).toBe(403);
  });

  it('grants are idempotent per (user, source)', async () => {
    const ann = browser('10.0.0.1');
    await confirm(ann, await signUp(ann, 'ann@acme.io'));
    const id = (await (await ann('GET', '/api/me')).json()).user.id;
    expect(await h.fleet.rewards.grantProDays(id, 7, 'manual:1')).toBeTruthy();
    expect(await h.fleet.rewards.grantProDays(id, 7, 'manual:1')).toBeNull();
    expect((await h.fleet.rewards.plan(id)).days_left).toBe(7);
  });

  it('redeem and plan need a signed-in person and a same-site browser', async () => {
    expect((await app.request('/api/v1/plan')).status).toBe(401);
    const ann = browser('10.0.0.1');
    await confirm(ann, await signUp(ann, 'ann@acme.io'));
    const cross = await app.request('/api/v1/credits/redeem', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"code":"x"}' });
    expect(cross.status).toBe(403);
  });
});

describe('invites', () => {
  it('an invite link signs a new person up, pays both sides once, and works only once', async () => {
    const inviter = browser('10.0.0.1');
    await confirm(inviter, await signUp(inviter, 'inviter@acme.io'));
    const inv = await makeInvite(inviter);
    expect(await (await inviter('GET', '/api/v1/invites')).json()).toMatchObject({ quota: { total: 3, used: 1, left: 2 } });

    // The invitee opens /i/<code> on a laptop, then confirms the emailed link on a phone.
    const laptop = browser('10.0.0.2');
    const landing = await laptop('GET', `/i/${inv.code}`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain(inv.code);
    const mail = await signUp(laptop, 'newbie@other.io');
    const phone = browser('10.0.0.3');
    await confirm(phone, mail);

    const plan = await (await phone('GET', '/api/v1/plan')).json();
    expect(plan).toMatchObject({ pro_active: true, days_left: 14 });
    expect(await (await inviter('GET', '/api/v1/plan')).json()).toMatchObject({ pro_active: true, days_left: 14 });
    const list = await (await inviter('GET', '/api/v1/invites')).json();
    expect(list.invites[0]).toMatchObject({ used: true, bonus: { status: 'granted', days: 14 } });

    // Signing in again pays nothing more; the invite cannot be used by anyone else.
    await phone('POST', '/api/auth/logout', {});
    await confirm(phone, await signUp(phone, 'newbie@other.io'));
    expect((await (await phone('GET', '/api/v1/plan')).json()).days_left).toBe(14);
    const third = browser('10.0.0.4');
    await confirm(third, await signUp(third, 'third@else.io'));
    const used = await third('POST', '/api/v1/invites/accept', { code: inv.code });
    expect(await used.json()).toMatchObject({ error: 'invite_used' });

    // One accepted invite per account.
    const other = await makeInvite(inviter);
    expect(await (await phone('POST', '/api/v1/invites/accept', { code: other.code })).json()).toMatchObject({ error: 'invite_already_invited' });
  });

  it('refuses the bonus for the same mailbox, a throwaway inbox and the same network', async () => {
    const inviter = browser('10.0.0.1');
    await confirm(inviter, await signUp(inviter, 'boss@gmail.com'));

    const alias = browser('10.0.0.9');
    await confirm(alias, await signUp(alias, 'b.o.s.s+2@gmail.com'));
    const r1 = await (await alias('POST', '/api/v1/invites/accept', { code: (await makeInvite(inviter)).code })).json();
    expect(r1.bonus).toMatchObject({ status: 'denied', reason: 'same mailbox' });

    const same = browser('10.0.0.1');
    await confirm(same, await signUp(same, 'colleague@acme.io'));
    const r2 = await (await same('POST', '/api/v1/invites/accept', { code: (await makeInvite(inviter)).code })).json();
    expect(r2.bonus).toMatchObject({ status: 'denied', reason: 'same network' });

    const throwaway = browser('10.0.0.7');
    await confirm(throwaway, await signUp(throwaway, 'x@mailinator.com'));
    const r3 = await (await throwaway('POST', '/api/v1/invites/accept', { code: (await makeInvite(inviter)).code })).json();
    expect(r3.bonus).toMatchObject({ status: 'denied', reason: 'throwaway email' });

    expect(await (await inviter('GET', '/api/v1/plan')).json()).toMatchObject({ pro_active: false });
    // Quota spent.
    expect((await inviter('POST', '/api/v1/invites', {})).status).toBe(409);
  });

  it('a ?ref= sign-up is attributed and cannot also earn an invite bonus', async () => {
    const affiliate = browser('10.0.0.1');
    await confirm(affiliate, await signUp(affiliate, 'aff@acme.io'));
    const { affiliate_code } = await (await affiliate('GET', '/api/v1/invites')).json();
    const visitor = browser('10.0.0.5');
    await visitor('GET', `/?ref=${affiliate_code}`);
    await confirm(visitor, await signUp(visitor, 'visitor@else.io'));
    const vid = (await (await visitor('GET', '/api/me')).json()).user.id;
    const aid = (await (await affiliate('GET', '/api/me')).json()).user.id;
    expect(await h.fleet.rewards.affiliates.affiliateOf(vid)).toBe(aid);
    const r = await (await visitor('POST', '/api/v1/invites/accept', { code: (await makeInvite(affiliate)).code })).json();
    expect(r.bonus).toMatchObject({ status: 'denied', reason: 'signed up through a referral link' });
  });

  it('keeps /i/<code> and /invites outside the crawl gate', async () => {
    const gate = createCrawlGate({ COINPAY_X402_KEY: 'k', CRAWL_PAY_TO: '0xabc' });
    const gated = buildApp(h.fleet, { crawlGate: gate });
    const ua = { 'user-agent': 'GPTBot/1.0' };
    expect((await gated.request('/i/INV-AAAA-BBBB-CCCC', { headers: ua })).status).toBe(200);
    expect((await gated.request('/docs', { headers: ua })).status).toBe(402);
  });
});

describe('rules', () => {
  it('canonical mailbox folds +tags and Gmail dots', () => {
    expect(canonicalMailbox('A.B+x@googlemail.com')).toBe('ab@gmail.com');
    expect(canonicalMailbox('a.b+x@acme.io')).toBe('a.b@acme.io');
  });
  it('bonus verdicts', () => {
    const u = (id: string, email: string) => ({ id, email, email_verified_at: '2026-01-01' });
    const base = { invitee: u('1', 'a@acme.io'), inviter: u('2', 'b@acme.io'), sameNetwork: false, referred: false, inviterPaidLast30Days: 0, cap: 5, bonusDays: 14 };
    expect(bonusVerdict(base).verdict).toBe('grant');
    expect(bonusVerdict({ ...base, inviterPaidLast30Days: 5 }).reason).toMatch(/cap/);
    expect(bonusVerdict({ ...base, bonusDays: 0 }).verdict).toBe('deny');
    expect(bonusVerdict({ ...base, invitee: { ...base.invitee, email_verified_at: null } }).verdict).toBe('wait');
  });
});
