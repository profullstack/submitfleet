import { createHash, randomBytes } from 'node:crypto';
import { all, one, run, type Db } from './db.js';
import { newId, nowIso, sha256, SubmitFleetError } from './util.js';
import { userWorkspace } from './auth.js';

/** Public clients only (no secrets): PKCE S256 is mandatory, refresh tokens rotate. */
export const OAUTH_CLIENTS: Record<string, { name: string; loopback: boolean }> = {
  'submitfleet-cli': { name: 'SubmitFleet CLI', loopback: true },
};

const CODE_MINUTES = 5;
const ACCESS_MINUTES = 60;
const REFRESH_DAYS = 30;
export const SCOPE = 'submitfleet';

export function validateClient(clientId: string, redirectUri: string): void {
  const c = OAUTH_CLIENTS[clientId];
  if (!c) throw new SubmitFleetError('invalid_client', 'unknown client_id');
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    throw new SubmitFleetError('invalid_request', 'redirect_uri is not a URL');
  }
  // RFC 8252: native apps use a loopback redirect on any port, plain http.
  const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost');
  if (!c.loopback || !loopback || u.username || u.password || u.hash) throw new SubmitFleetError('invalid_request', 'redirect_uri must be a loopback address');
}

export function validateAuthorizeParams(q: Record<string, string | undefined>): { clientId: string; redirectUri: string; challenge: string; state: string } {
  if (q.response_type !== 'code') throw new SubmitFleetError('unsupported_response_type', 'response_type must be code');
  validateClient(q.client_id ?? '', q.redirect_uri ?? '');
  if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? '')) {
    throw new SubmitFleetError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  return { clientId: q.client_id!, redirectUri: q.redirect_uri!, challenge: q.code_challenge!, state: q.state ?? '' };
}

export async function issueCode(db: Db, userId: string, clientId: string, redirectUri: string, challenge: string): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await run(
    db,
    'INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(code), userId, clientId, redirectUri, challenge, SCOPE, new Date(Date.now() + CODE_MINUTES * 60_000).toISOString(),
  );
  return code;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function mintPair(db: Db, userId: string, clientId: string, family: string): Promise<TokenResponse> {
  const m = await userWorkspace(db, userId);
  if (!m) throw new SubmitFleetError('invalid_grant', 'account has no workspace');
  const access = `sf_oat_${randomBytes(32).toString('base64url')}`;
  const keyId = newId('key');
  const ts = nowIso();
  await run(
    db,
    'INSERT INTO api_keys (id, workspace_id, role, label, token_hash, created_at, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    keyId, m.workspace_id, m.role === 'owner' ? 'owner' : 'agent', `oauth:${clientId}`, sha256(access), ts, userId, new Date(Date.now() + ACCESS_MINUTES * 60_000).toISOString(),
  );
  const refresh = `sf_ort_${randomBytes(32).toString('base64url')}`;
  await run(
    db,
    'INSERT INTO oauth_refresh (token_hash, family, user_id, workspace_id, client_id, access_key_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(refresh), family, userId, m.workspace_id, clientId, keyId, ts, new Date(Date.now() + REFRESH_DAYS * 86_400_000).toISOString(),
  );
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MINUTES * 60, refresh_token: refresh, scope: SCOPE };
}

export async function exchangeCode(db: Db, p: { code: string; client_id: string; redirect_uri: string; code_verifier: string }): Promise<TokenResponse> {
  const h = sha256(p.code ?? '');
  const ts = nowIso();
  const n = await run(db, 'UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', ts, h, ts);
  const row = await one<{ user_id: string; client_id: string; redirect_uri: string; code_challenge: string }>(db, 'SELECT * FROM oauth_codes WHERE code_hash = ?', h);
  if (n !== 1 || !row) throw new SubmitFleetError('invalid_grant', 'code is invalid, expired or already used');
  if (row.client_id !== p.client_id || row.redirect_uri !== p.redirect_uri) throw new SubmitFleetError('invalid_grant', 'client or redirect_uri mismatch');
  const expected = createHash('sha256').update(p.code_verifier ?? '').digest('base64url');
  if (!p.code_verifier || expected !== row.code_challenge) throw new SubmitFleetError('invalid_grant', 'code_verifier does not match');
  return mintPair(db, row.user_id, row.client_id, newId('fam'));
}

/** Rotation: each refresh token works once. Presenting a spent one revokes the whole family. */
export async function refresh(db: Db, token: string, clientId: string): Promise<TokenResponse> {
  const h = sha256(token ?? '');
  const row = await one<{ family: string; user_id: string; client_id: string; expires_at: string; used_at: string | null; revoked_at: string | null }>(db, 'SELECT * FROM oauth_refresh WHERE token_hash = ?', h);
  if (!row || row.client_id !== clientId) throw new SubmitFleetError('invalid_grant', 'refresh token is invalid');
  if (row.used_at || row.revoked_at) {
    await revokeFamily(db, row.family);
    throw new SubmitFleetError('invalid_grant', 'refresh token was already used; sign in again');
  }
  if (Date.parse(row.expires_at) <= Date.now()) throw new SubmitFleetError('invalid_grant', 'refresh token expired; sign in again');
  const n = await run(db, 'UPDATE oauth_refresh SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', nowIso(), h);
  if (n !== 1) {
    await revokeFamily(db, row.family);
    throw new SubmitFleetError('invalid_grant', 'refresh token was already used; sign in again');
  }
  return mintPair(db, row.user_id, row.client_id, row.family);
}

export async function revokeFamily(db: Db, family: string): Promise<void> {
  const ts = nowIso();
  const keys = await all<{ access_key_id: string | null }>(db, 'SELECT access_key_id FROM oauth_refresh WHERE family = ?', family);
  await run(db, 'UPDATE oauth_refresh SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL', ts, family);
  for (const k of keys) if (k.access_key_id) await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', ts, k.access_key_id);
}

/** RFC 7009: revoking either token ends the whole sign-in. Unknown tokens are not an error. */
export async function revokeToken(db: Db, token: string): Promise<void> {
  const h = sha256(token ?? '');
  const r = await one<{ family: string }>(db, 'SELECT family FROM oauth_refresh WHERE token_hash = ?', h);
  if (r) return revokeFamily(db, r.family);
  const k = await one<{ id: string }>(db, 'SELECT id FROM api_keys WHERE token_hash = ?', h);
  if (k) {
    const f = await one<{ family: string }>(db, 'SELECT family FROM oauth_refresh WHERE access_key_id = ?', k.id);
    if (f) return revokeFamily(db, f.family);
    await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', nowIso(), k.id);
  }
}

export function metadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}
