import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { descriptorResponse, footerHtml, latestTemplate } from '@profullstack/footer';
import * as auth from './auth.js';
import { PROFILE_ENHANCE_SCRIPT, renderProfileFields, validateProfile } from '@profullstack/profile';
import { escapeHtml } from './adapters/tinylaunch.js';
import { loginMail, signupMail, type Mailer } from './mail.js';
import * as oauth from './oauth.js';
import type { SubmitFleet } from './service.js';
import { SubmitFleetError } from './util.js';
import { authenticate, type Actor } from './workspaces.js';
import { withPitFooter } from './pit-footer.js';
import { REF_COOKIE, refFromRequest } from '@profullstack/affiliates';
import { INVITE_COOKIE, inviteBonusDays } from './rewards.js';

const COOKIE_CODE = /^[A-Za-z0-9-]{6,48}$/;
/** An invite or affiliate code from a cookie or URL, or null when it is not code-shaped. */
export function cleanCode(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return COOKIE_CODE.test(t) ? t : null;
}

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.html': 'text/html; charset=utf-8',
};

// pit.world: the footer's newsletter form POSTs to pit.world/api/subscribe (connect-src),
// falling back to a plain form POST to pit.world/subscribe without script (form-action).
export const PAGE_CSP =
  "default-src 'self'; script-src 'self' https://crawlproof.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://crawlproof.com https://pit.world; font-src 'self'; frame-src https://crawlproof.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://pit.world http://127.0.0.1:* http://localhost:*";

/** PAGE_CSP plus a per-response nonce in script-src, for the footer's inline subscribe script. */
export function pageCsp(nonce?: string): string {
  return nonce ? PAGE_CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`) : PAGE_CSP;
}

/** A fresh CSP nonce for one response. */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

export interface WebOptions {
  mailer: Mailer;
  /** Canonical public origin, e.g. https://submitfleet.com. Falls back to the request's forwarded origin. */
  publicOrigin?: string;
}

export function requestOrigin(c: Context): string {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}

export function clientIp(c: Context): string {
  return c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}

/** Browser-originated state changes must come from our own pages. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === (c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host);
  } catch {
    return false;
  }
}

/** Bearer API key / OAuth token, or the signed-in browser session. */
export async function resolveActor(fleet: SubmitFleet, c: Context): Promise<{ actor: Actor; viaCookie: boolean } | null> {
  const h = c.req.header('authorization') ?? '';
  if (h.startsWith('Bearer ')) {
    const actor = await authenticate(fleet.db, h.slice(7).trim());
    return actor ? { actor, viaCookie: false } : null;
  }
  const user = await auth.sessionUser(fleet.db, getCookie(c, auth.SESSION_COOKIE));
  if (!user) return null;
  const actor = await auth.actorForUser(fleet.db, user.id);
  return actor ? { actor, viaCookie: true } : null;
}

function loadStatic(): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else files.set(`${prefix}${e.name}`, { body: readFileSync(join(dir, e.name)), type: TYPES[extname(e.name)] ?? 'application/octet-stream' });
    }
  };
  walk(WEB_ROOT, '');
  return files;
}

export const SITE_URL = 'https://submitfleet.com/';

/**
 * The shared Profullstack footer (links, copyright, << Profullstack >> webring),
 * rendered on the server from the @latest template so the ring verifier, which
 * reads HTML and runs no script, sees the ring links. Its CSS is served from
 * /assets/pfs-footer.css (css: false here), so the footer does not depend on
 * style-src allowing inline styles.
 */
export function siteFooter(links: { label: string; href: string }[], nonce?: string): Promise<string> {
  return footerHtml({ site: SITE_URL, links, css: false, nonce });
}

function safeNext(raw: string | undefined): string {
  // Only same-site paths: never "//evil", never a scheme.
  return raw && /^\/(?!\/)[\w\-./?=&%#]*$/.test(raw) ? raw : '/app';
}

export function mountWeb(app: Hono<{ Variables: { actor: Actor } }>, fleet: SubmitFleet, opts: WebOptions): void {
  const files = loadStatic();
  const page = (name: string) => files.get(name)!.body.toString('utf8');
  const origin = (c: Context) => opts.publicOrigin ?? requestOrigin(c);
  const rp = (c: Context): auth.RelyingParty => {
    const o = origin(c);
    return { origin: o, rpID: new URL(o).hostname, rpName: 'SubmitFleet' };
  };
  const html = async (c: Context, body: string, status = 200, nonce?: string) => {
    c.header('content-security-policy', pageCsp(nonce));
    c.header('cache-control', 'no-store');
    return c.html(await withPitFooter(body), status as 200);
  };
  const startSession = async (c: Context, userId: string) => {
    const s = await auth.createSession(fleet.db, userId, c.req.header('user-agent') ?? null);
    setCookie(c, auth.SESSION_COOKIE, s.token, {
      httpOnly: true,
      secure: origin(c).startsWith('https:'),
      sameSite: 'Lax',
      path: '/',
      expires: s.expires,
    });
  };
  const limited = (c: Context, key: string, n: number, minutes: number) => !auth.allow(`${key}:${clientIp(c)}`, n, minutes * 60_000);
  const guard = (c: Context) => {
    if (!sameOrigin(c)) throw new SubmitFleetError('origin_not_allowed', 'cross-site request refused');
  };
  const json = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    const r = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!r.success) throw new SubmitFleetError('invalid_request', r.error.issues[0]?.message ?? 'invalid body');
    return r.data;
  };
  /** Sends at most 3 emails per address per 15 minutes; the caller answers the same either way. */
  const sendLink = async (c: Context, email: string, purpose: auth.LinkPurpose, data: Record<string, unknown> = {}) => {
    if ((await auth.recentEmailCount(fleet.db, email)) >= 3) return;
    const existing = await auth.getUserByEmail(fleet.db, email);
    // An existing account always gets a plain sign-in link, so sign-up never reveals or overwrites anything.
    const p: auth.LinkPurpose = existing ? 'login' : purpose;
    // The invite and ?ref= codes ride on the link, so finishing in another browser still counts them.
    const meta: auth.LinkMeta = { invite_code: cleanCode(getCookie(c, INVITE_COOKIE)), ref_code: cleanCode(getCookie(c, REF_COOKIE)) };
    const token = await auth.createEmailToken(fleet.db, email, p, existing ? { ...meta } : { ...data, ...meta });
    const url = `${origin(c)}/auth/link#t=${token}`;
    try {
      await opts.mailer(p === 'signup' ? signupMail(email, url) : loginMail(email, url, !!existing));
    } catch (e) {
      console.error('[submitfleet] mail send failed:', e instanceof Error ? e.message : e);
      throw new SubmitFleetError('mail_unavailable', 'We could not send the email just now. Try again in a minute, or sign in with a passkey or password.');
    }
  };
  const SENT = { ok: true, message: 'If that address can receive mail, a link is on its way. It expires in 20 minutes.' };

  /**
   * After any sign-in: accept a pending invite (from the emailed link or the /i/<code>
   * cookie) for a new account, and record first-touch ?ref= attribution for a brand-new one.
   * Never blocks the sign-in.
   */
  const afterSignIn = async (c: Context, userId: string, created: boolean, meta: auth.LinkMeta = {}) => {
    try {
      const invite = cleanCode(meta.invite_code) ?? cleanCode(getCookie(c, INVITE_COOKIE));
      if (invite) {
        await fleet.rewards.acceptQuietly(userId, invite, clientIp(c));
        deleteCookie(c, INVITE_COOKIE, { path: '/' });
      }
      if (created) await fleet.rewards.attribute(cleanCode(meta.ref_code) ?? cleanCode(refFromRequest(c.req.raw)), userId);
    } catch (e) {
      console.error('[submitfleet] after sign-in:', e instanceof Error ? e.message : e);
    }
  };

  // First-touch ?ref= on any page: remembered for 30 days, never overwritten.
  app.use('*', async (c, next) => {
    const ref = c.req.method === 'GET' ? cleanCode(c.req.query('ref')) : null;
    if (ref && !getCookie(c, REF_COOKIE)) {
      setCookie(c, REF_COOKIE, ref, { httpOnly: true, secure: origin(c).startsWith('https:'), sameSite: 'Lax', path: '/', maxAge: 30 * 86_400 });
    }
    await next();
  });

  // ── Pages ──
  app.get('/', async (c) => {
    const stats = await fleet.catalogStats();
    const nonce = newNonce();
    const body = page('index.html')
      .replace('{{FOOTER}}', await siteFooter([{ label: 'Docs', href: '/docs' }, { label: 'GitHub', href: 'https://github.com/profullstack/submitfleet' }, { label: 'Sign in', href: '/login' }], nonce))
      .replaceAll('{{TOTAL}}', String(stats.total))
      .replaceAll('{{FREE}}', String(stats.free))
      .replaceAll('{{DIRECTORIES}}', String((stats.by_channel.directory ?? 0) + (stats.by_channel.citation ?? 0)))
      .replaceAll('{{LAUNCH}}', String(stats.by_channel['product-launch-site'] ?? 0))
      .replaceAll('{{AUTOMATED}}', String(stats.automated));
    return html(c, body, 200, nonce);
  });
  // Sign-up asks for the profile fields (the form has its own email box); sign-in never does.
  const signupFields = renderProfileFields({ fields: ['first_name', 'last_name', 'company_domain', 'job_title', 'linkedin_url'] });
  app.get('/signup', (c) => html(c, page('auth.html').replace('{{PROFILE_FIELDS}}', signupFields)));
  app.get('/login', (c) => html(c, page('auth.html').replace('{{PROFILE_FIELDS}}', '')));
  app.get('/auth/link', (c) => html(c, page('link.html')));
  app.get('/docs', async (c) => {
    const nonce = newNonce();
    return html(c, page('docs.html').replace('{{FOOTER}}', await siteFooter([{ label: 'Home', href: '/' }, { label: 'GitHub', href: 'https://github.com/profullstack/submitfleet' }], nonce)), 200, nonce);
  });
  app.get('/.well-known/openwebring.json', () => descriptorResponse({ site: SITE_URL, name: 'SubmitFleet' }));
  const appShell = async (c: Context) => {
    const user = await auth.sessionUser(fleet.db, getCookie(c, auth.SESSION_COOKIE));
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`);
    return html(c, page('app.html'));
  };
  // Invite landing: remembers the code on this device, then sign-up. Outside every gate.
  app.get('/i/:code', async (c) => {
    const code = cleanCode(c.req.param('code'));
    if (!code) return html(c, page('error.html').replace('{{MESSAGE}}', 'That invite link is not valid.'), 404);
    setCookie(c, INVITE_COOKIE, code, { httpOnly: true, secure: origin(c).startsWith('https:'), sameSite: 'Lax', path: '/', maxAge: 30 * 86_400 });
    const stats = await fleet.catalogStats();
    return html(
      c,
      page('invite.html').replaceAll('{{CODE}}', escapeHtml(code)).replaceAll('{{DAYS}}', String(inviteBonusDays())).replaceAll('{{TOTAL}}', String(stats.total)),
    );
  });
  app.get('/invites', (c) => c.redirect('/app/invites'));
  app.get('/app', appShell);
  app.get('/app/*', appShell);
  // The footer template's CSS (@latest, same cache as the markup); before /assets/*.
  app.get('/assets/pfs-footer.css', async (c) =>
    c.body((await latestTemplate()).css.replace(/@import[^;]*;?/gi, '').replace(/<\/?style/gi, ''), 200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=300',
    }),
  );
  // Fills company domain from a work email; a file, not inline, because of PAGE_CSP.
  app.get('/assets/profile-enhance.js', (c) =>
    c.body(PROFILE_ENHANCE_SCRIPT, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' }),
  );
  app.get('/assets/*', (c) => {
    const f = files.get(c.req.path.replace(/^\//, ''));
    if (!f) return c.notFound();
    return c.body(new Uint8Array(f.body), 200, { 'content-type': f.type, 'cache-control': 'public, max-age=300' });
  });
  app.get('/favicon.ico', (c) => c.body(new Uint8Array(files.get('assets/icon.svg')!.body), 200, { 'content-type': 'image/svg+xml' }));
  app.get('/d/:slug/icon', async (c) => {
    const i = await fleet.destinationIcon(c.req.param('slug'));
    if (!i) return c.body(new Uint8Array(files.get('assets/dest.svg')!.body), 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    return c.body(new Uint8Array(i.bytes), 200, { 'content-type': i.type, 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'" });
  });
  app.get('/p/:id/logo', async (c) => {
    const l = await fleet.productLogo(c.req.param('id'));
    if (!l) return c.notFound();
    return c.body(new Uint8Array(l.bytes), 200, { 'content-type': l.mime, 'cache-control': 'public, max-age=3600', 'content-security-policy': "default-src 'none'" });
  });

  // ── Auth API ──
  const emailBody = z.object({ email: z.string().max(254) });
  app.post('/api/auth/signup', async (c) => {
    guard(c);
    const field = z.string().max(300).nullish();
    const b = await json(
      c,
      z.object({
        email: z.string().max(254),
        password: z.string().max(200).optional(),
        name: z.string().max(80).optional(),
        first_name: field,
        last_name: field,
        company_domain: field,
        job_title: field,
        linkedin_url: field,
      }),
    );
    const email = auth.normalizeEmail(b.email);
    if (b.password) auth.checkPasswordStrength(b.password);
    const profile = validateProfile({ ...b, email });
    if (!profile.ok) throw new SubmitFleetError('invalid_request', Object.values(profile.errors)[0] ?? 'check the profile fields', profile.errors);
    if (limited(c, 'signup', 10, 10)) return c.json(SENT);
    const name = b.name?.trim() || [profile.profile.first_name, profile.profile.last_name].filter(Boolean).join(' ') || null;
    // The validated profile rides on the link and is saved when the account is created.
    await sendLink(c, email, 'signup', { name, password_hash: b.password ? await auth.hashPassword(b.password) : null, profile: profile.profile });
    return c.json(SENT);
  });
  app.post('/api/auth/magic', async (c) => {
    guard(c);
    const b = await json(c, emailBody);
    const email = auth.normalizeEmail(b.email);
    if (limited(c, 'magic', 10, 10)) return c.json(SENT);
    await sendLink(c, email, 'login');
    return c.json(SENT);
  });
  app.post('/api/auth/link', async (c) => {
    guard(c);
    const b = await json(c, z.object({ token: z.string().min(20).max(100) }));
    if (limited(c, 'link', 30, 10)) throw new SubmitFleetError('rate_limited', 'too many attempts; wait a few minutes');
    const r = await auth.consumeEmailToken(fleet.db, b.token);
    await startSession(c, r.user.id);
    await afterSignIn(c, r.user.id, r.created, r.meta);
    return c.json({ ok: true, created: r.created, user: { email: r.user.email } });
  });
  app.post('/api/auth/login', async (c) => {
    guard(c);
    const b = await json(c, z.object({ email: z.string().max(254), password: z.string().max(200) }));
    if (limited(c, 'login', 20, 10)) throw new SubmitFleetError('rate_limited', 'too many attempts; wait a few minutes or use an emailed link');
    const user = await auth.loginWithPassword(fleet.db, b.email, b.password);
    await startSession(c, user.id);
    await afterSignIn(c, user.id, false);
    return c.json({ ok: true });
  });
  app.post('/api/auth/logout', async (c) => {
    guard(c);
    const t = getCookie(c, auth.SESSION_COOKIE);
    if (t) await auth.deleteSession(fleet.db, t);
    deleteCookie(c, auth.SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });
  app.post('/api/auth/passkey/login/options', async (c) => {
    guard(c);
    if (limited(c, 'pk', 30, 10)) throw new SubmitFleetError('rate_limited', 'too many attempts');
    return c.json(await auth.passkeyLoginOptions(fleet.db, rp(c)));
  });
  app.post('/api/auth/passkey/login/verify', async (c) => {
    guard(c);
    const b = await json(c, z.object({ challenge_id: z.string(), response: z.record(z.string(), z.unknown()) }));
    const user = await auth.passkeyLogin(fleet.db, rp(c), b.challenge_id, b.response as unknown as AuthenticationResponseJSON);
    await startSession(c, user.id);
    await afterSignIn(c, user.id, false);
    return c.json({ ok: true });
  });

  // ── Account (browser session) ──
  const sessionUser = async (c: Context) => {
    const u = await auth.sessionUser(fleet.db, getCookie(c, auth.SESSION_COOKIE));
    if (!u) throw new SubmitFleetError('unauthorized', 'sign in first');
    return u;
  };
  app.get('/api/me', async (c) => {
    const r = await resolveActor(fleet, c);
    if (!r) return c.json({ error: 'unauthorized' }, 401);
    const userId = r.actor.id.startsWith('user:') ? r.actor.id.slice(5) : null;
    const user = userId ? await auth.getUser(fleet.db, userId) : null;
    return c.json({
      workspace_id: r.actor.workspaceId,
      role: r.actor.role,
      user: user ? { id: user.id, email: user.email, name: user.name, created_at: user.created_at } : null,
      has_password: user ? await auth.hasPassword(fleet.db, user.id) : null,
      passkeys: user ? await auth.listPasskeys(fleet.db, user.id) : [],
    });
  });
  app.post('/api/account/password', async (c) => {
    guard(c);
    const u = await sessionUser(c);
    const b = await json(c, z.object({ password: z.string().max(200) }));
    await auth.setPassword(fleet.db, u.id, b.password);
    return c.json({ ok: true });
  });
  app.post('/api/account/passkeys/options', async (c) => {
    guard(c);
    return c.json(await auth.passkeyRegistrationOptions(fleet.db, rp(c), await sessionUser(c)));
  });
  app.post('/api/account/passkeys', async (c) => {
    guard(c);
    const u = await sessionUser(c);
    const b = await json(c, z.object({ challenge_id: z.string(), response: z.record(z.string(), z.unknown()), name: z.string().max(60).optional() }));
    return c.json(await auth.passkeyRegister(fleet.db, rp(c), u, b.challenge_id, b.response as unknown as RegistrationResponseJSON, b.name));
  });
  app.delete('/api/account/passkeys/:id', async (c) => {
    guard(c);
    await auth.deletePasskey(fleet.db, (await sessionUser(c)).id, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── OAuth 2.1 for the CLI ──
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(oauth.metadata(origin(c))));
  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    let params;
    try {
      params = oauth.validateAuthorizeParams(q);
    } catch (e) {
      return html(c, page('error.html').replace('{{MESSAGE}}', escapeHtml(e instanceof Error ? e.message : 'invalid request')), 400);
    }
    const user = await auth.sessionUser(fleet.db, getCookie(c, auth.SESSION_COOKIE));
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`);
    const hidden = Object.entries({ client_id: params.clientId, redirect_uri: params.redirectUri, code_challenge: params.challenge, state: params.state })
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
      .join('');
    return html(
      c,
      page('authorize.html')
        .replaceAll('{{CLIENT}}', escapeHtml(oauth.OAUTH_CLIENTS[params.clientId]!.name))
        .replaceAll('{{EMAIL}}', escapeHtml(user.email))
        .replace('{{HIDDEN}}', hidden),
    );
  });
  app.post('/oauth/authorize', async (c) => {
    guard(c);
    const user = await sessionUser(c);
    const f = await c.req.parseBody();
    const get = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
    const p = oauth.validateAuthorizeParams({ response_type: 'code', code_challenge_method: 'S256', client_id: get('client_id'), redirect_uri: get('redirect_uri'), code_challenge: get('code_challenge'), state: get('state') });
    const target = new URL(p.redirectUri);
    if (get('decision') !== 'allow') {
      target.searchParams.set('error', 'access_denied');
    } else {
      target.searchParams.set('code', await oauth.issueCode(fleet.db, user.id, p.clientId, p.redirectUri, p.challenge));
    }
    if (p.state) target.searchParams.set('state', p.state);
    return c.redirect(target.toString(), 302);
  });
  const tokenBody = async (c: Context): Promise<Record<string, string>> => {
    const type = c.req.header('content-type') ?? '';
    if (type.includes('application/json')) return (await c.req.json().catch(() => ({}))) as Record<string, string>;
    const f = await c.req.parseBody();
    return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  };
  app.post('/oauth/token', async (c) => {
    c.header('cache-control', 'no-store');
    const b = await tokenBody(c);
    try {
      if (limited(c, 'token', 60, 10)) throw new SubmitFleetError('invalid_request', 'too many requests');
      if (b.grant_type === 'authorization_code') {
        return c.json(await oauth.exchangeCode(fleet.db, { code: b.code ?? '', client_id: b.client_id ?? '', redirect_uri: b.redirect_uri ?? '', code_verifier: b.code_verifier ?? '' }));
      }
      if (b.grant_type === 'refresh_token') return c.json(await oauth.refresh(fleet.db, b.refresh_token ?? '', b.client_id ?? ''));
      throw new SubmitFleetError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    } catch (e) {
      const code = e instanceof SubmitFleetError ? e.code : 'server_error';
      return c.json({ error: code, error_description: e instanceof Error ? e.message : '' }, code === 'server_error' ? 500 : 400);
    }
  });
  app.post('/oauth/revoke', async (c) => {
    const b = await tokenBody(c);
    if (b.token) await oauth.revokeToken(fleet.db, b.token);
    return c.body(null, 200);
  });
}
