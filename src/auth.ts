import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { all, one, run, type Db } from './db.js';
import { newId, nowIso, parseJson, sha256, SubmitFleetError } from './util.js';
import { createWorkspace, type Actor } from './workspaces.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const SESSION_COOKIE = 'sf_session';
export const SESSION_DAYS = 30;
const LINK_MINUTES = 20;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;

export interface User {
  id: string;
  email: string;
  name: string | null;
  email_verified_at: string | null;
  created_at: string;
}

const USER_COLS = 'id, email, name, email_verified_at, created_at';

export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new SubmitFleetError('invalid_request', 'enter a valid email address');
  return e;
}

export function checkPasswordStrength(pw: string): void {
  if (pw.length < 10) throw new SubmitFleetError('weak_password', 'use at least 10 characters');
  if (pw.length > 200) throw new SubmitFleetError('weak_password', 'use at most 200 characters');
}

// ── Passwords: scrypt, self-describing format ──
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

// A real hash of a random password, so unknown accounts cost the same time as known ones.
let decoy: Promise<string> | null = null;
const decoyHash = () => (decoy ??= hashPassword(randomBytes(16).toString('hex')));

// ── Users and workspaces ──

export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  return one<User>(db, `SELECT ${USER_COLS} FROM users WHERE email = ?`, email);
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  return one<User>(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`, id);
}

/** Creates the user with a workspace they own. The email is verified by the act of using the emailed link. */
export async function createUser(db: Db, email: string, opts: { name?: string | null; passwordHash?: string | null } = {}): Promise<User> {
  const id = newId('usr');
  const ts = nowIso();
  await run(db, 'INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, opts.name ?? null, opts.passwordHash ?? null, ts, ts, ts);
  const ws = await createWorkspace(db, opts.name ? `${opts.name}'s workspace` : email);
  await run(db, "INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?, ?, 'owner', ?)", id, ws, ts);
  return (await getUser(db, id))!;
}

export async function userWorkspace(db: Db, userId: string): Promise<{ workspace_id: string; role: string } | null> {
  return one(db, 'SELECT workspace_id, role FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1', userId);
}

export async function actorForUser(db: Db, userId: string): Promise<Actor | null> {
  const m = await userWorkspace(db, userId);
  return m ? { workspaceId: m.workspace_id, role: m.role === 'owner' ? 'owner' : 'agent', id: `user:${userId}` } : null;
}

export async function setPassword(db: Db, userId: string, pw: string): Promise<void> {
  checkPasswordStrength(pw);
  await run(db, 'UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', await hashPassword(pw), nowIso(), userId);
}

/**
 * Password sign-in. Every failure looks the same (no hint whether the address exists),
 * unknown addresses still pay for a hash, and ten failures lock password sign-in for a
 * while; the emailed link keeps working during a lock.
 */
export async function loginWithPassword(db: Db, emailRaw: string, pw: string, now = Date.now()): Promise<User> {
  const email = normalizeEmail(emailRaw);
  const row = await one<{ id: string; password_hash: string | null; failed_logins: number; locked_until: string | null }>(
    db,
    'SELECT id, password_hash, failed_logins, locked_until FROM users WHERE email = ?',
    email,
  );
  const fail = new SubmitFleetError('invalid_credentials', 'that email and password do not match');
  if (!row || !row.password_hash) {
    await verifyPassword(pw, await decoyHash());
    throw fail;
  }
  if (row.locked_until && Date.parse(row.locked_until) > now) {
    await verifyPassword(pw, await decoyHash());
    throw new SubmitFleetError('locked', 'too many attempts; sign in with an emailed link instead');
  }
  if (!(await verifyPassword(pw, row.password_hash))) {
    const n = Number(row.failed_logins) + 1;
    await run(db, 'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', n, n >= MAX_FAILED_LOGINS ? new Date(now + LOCK_MINUTES * 60_000).toISOString() : null, row.id);
    throw fail;
  }
  await run(db, 'UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', row.id);
  return (await getUser(db, row.id))!;
}

// ── Sessions ──

export async function createSession(db: Db, userId: string, userAgent: string | null, now = Date.now()): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now + SESSION_DAYS * 86_400_000);
  await run(db, 'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)', sha256(token), userId, new Date(now).toISOString(), expires.toISOString(), userAgent?.slice(0, 300) ?? null);
  return { token, expires };
}

export async function sessionUser(db: Db, token: string | null | undefined, now = Date.now()): Promise<User | null> {
  if (!token) return null;
  const r = await one<{ user_id: string; expires_at: string }>(db, 'SELECT user_id, expires_at FROM sessions WHERE id_hash = ?', sha256(token));
  if (!r || Date.parse(r.expires_at) <= now) return null;
  return getUser(db, r.user_id);
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await run(db, 'DELETE FROM sessions WHERE id_hash = ?', sha256(token));
}

// ── Emailed links (sign-up confirmation and magic sign-in) ──

export type LinkPurpose = 'signup' | 'login';

export async function createEmailToken(db: Db, email: string, purpose: LinkPurpose, data: Record<string, unknown> = {}, now = Date.now()): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await run(
    db,
    'INSERT INTO email_tokens (token_hash, email, purpose, data_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), email, purpose, JSON.stringify(data), new Date(now).toISOString(), new Date(now + LINK_MINUTES * 60_000).toISOString(),
  );
  return token;
}

/** Emails sent to one address in the last window, to cap mail to any single inbox. */
export async function recentEmailCount(db: Db, email: string, minutes = 15, now = Date.now()): Promise<number> {
  const r = await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM email_tokens WHERE email = ? AND created_at >= ?', email, new Date(now - minutes * 60_000).toISOString());
  return Number(r?.n ?? 0);
}

/**
 * Spends a link once. A sign-up link creates the account (only now, so nobody can squat
 * an address they cannot read); a sign-in link for an unknown address also creates it,
 * which makes the emailed link the way in from nothing.
 */
export async function consumeEmailToken(db: Db, token: string, now = Date.now()): Promise<{ user: User; created: boolean; purpose: LinkPurpose }> {
  const h = sha256(token);
  const ts = new Date(now).toISOString();
  const n = await run(db, 'UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', ts, h, ts);
  if (n !== 1) throw new SubmitFleetError('link_invalid', 'this link has expired or was already used; request a new one');
  const row = (await one<{ email: string; purpose: LinkPurpose; data_json: string }>(db, 'SELECT email, purpose, data_json FROM email_tokens WHERE token_hash = ?', h))!;
  const data = parseJson<{ name?: string; password_hash?: string }>(row.data_json, {});
  const existing = await getUserByEmail(db, row.email);
  if (existing) {
    await run(db, 'UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), failed_logins = 0, locked_until = NULL WHERE id = ?', ts, existing.id);
    return { user: existing, created: false, purpose: row.purpose };
  }
  const user = await createUser(db, row.email, { name: data.name ?? null, passwordHash: data.password_hash ?? null });
  return { user, created: true, purpose: row.purpose };
}

// ── Passkeys ──

export interface RelyingParty {
  rpID: string;
  origin: string;
  rpName: string;
}

export async function passkeyRegistrationOptions(db: Db, rp: RelyingParty, user: User) {
  const existing = await all<{ id: string; transports_json: string }>(db, 'SELECT id, transports_json FROM passkeys WHERE user_id = ?', user.id);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name ?? user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: parseJson<AuthenticatorTransportFuture[]>(p.transports_json, []) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await saveChallenge(db, options.challenge, user.id, 'register');
  return { challenge_id: challengeId, options };
}

export async function passkeyRegister(db: Db, rp: RelyingParty, user: User, challengeId: string, response: RegistrationResponseJSON, name?: string): Promise<{ id: string }> {
  const challenge = await takeChallenge(db, challengeId, 'register', user.id);
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: false });
  if (!v.verified || !v.registrationInfo) throw new SubmitFleetError('passkey_failed', 'the passkey could not be verified');
  const c = v.registrationInfo.credential;
  await run(
    db,
    'INSERT INTO passkeys (id, user_id, public_key, counter, transports_json, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    c.id, user.id, Buffer.from(c.publicKey).toString('base64url'), c.counter, JSON.stringify(c.transports ?? response.response.transports ?? []), name?.slice(0, 60) ?? 'Passkey', nowIso(),
  );
  return { id: c.id };
}

export async function passkeyLoginOptions(db: Db, rp: RelyingParty) {
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
  const challengeId = await saveChallenge(db, options.challenge, null, 'login');
  return { challenge_id: challengeId, options };
}

export async function passkeyLogin(db: Db, rp: RelyingParty, challengeId: string, response: AuthenticationResponseJSON): Promise<User> {
  const challenge = await takeChallenge(db, challengeId, 'login', null);
  const pk = await one<{ id: string; user_id: string; public_key: string; counter: number; transports_json: string }>(db, 'SELECT * FROM passkeys WHERE id = ?', response.id);
  if (!pk) throw new SubmitFleetError('passkey_failed', 'that passkey is not registered here');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
    credential: { id: pk.id, publicKey: Buffer.from(pk.public_key, 'base64url'), counter: Number(pk.counter), transports: parseJson(pk.transports_json, []) },
  });
  if (!v.verified) throw new SubmitFleetError('passkey_failed', 'the passkey could not be verified');
  await run(db, 'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', v.authenticationInfo.newCounter, nowIso(), pk.id);
  return (await getUser(db, pk.user_id))!;
}

export async function listPasskeys(db: Db, userId: string) {
  return all(db, 'SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at', userId);
}

export async function deletePasskey(db: Db, userId: string, id: string): Promise<void> {
  const n = await run(db, 'DELETE FROM passkeys WHERE id = ? AND user_id = ?', id, userId);
  if (!n) throw new SubmitFleetError('not_found', 'passkey');
}

export async function hasPassword(db: Db, userId: string): Promise<boolean> {
  const r = await one<{ p: string | null }>(db, 'SELECT password_hash AS p FROM users WHERE id = ?', userId);
  return !!r?.p;
}

async function saveChallenge(db: Db, challenge: string, userId: string | null, purpose: string): Promise<string> {
  const id = newId('chl');
  await run(db, "DELETE FROM auth_challenges WHERE expires_at < ?", nowIso());
  await run(db, 'INSERT INTO auth_challenges (id, challenge, user_id, purpose, expires_at) VALUES (?, ?, ?, ?, ?)', id, challenge, userId, purpose, new Date(Date.now() + 5 * 60_000).toISOString());
  return id;
}

async function takeChallenge(db: Db, id: string, purpose: string, userId: string | null): Promise<string> {
  const r = await one<{ challenge: string; user_id: string | null; purpose: string; expires_at: string }>(db, 'SELECT * FROM auth_challenges WHERE id = ?', id);
  await run(db, 'DELETE FROM auth_challenges WHERE id = ?', id);
  if (!r || r.purpose !== purpose || Date.parse(r.expires_at) < Date.now() || (userId && r.user_id !== userId)) {
    throw new SubmitFleetError('passkey_failed', 'that request expired; try again');
  }
  return r.challenge;
}

// ── Rate limiting (per process; one app process per site) ──

const buckets = new Map<string, { n: number; reset: number }>();

/** Returns false once `key` has been seen `limit` times in the window. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || b.reset <= now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
    return true;
  }
  b.n++;
  return b.n <= limit;
}

export function resetRateLimits(): void {
  buckets.clear();
}
