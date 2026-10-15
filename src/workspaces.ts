import { randomBytes } from 'node:crypto';
import { all, one, run, type Db } from './db.js';
import { newId, nowIso, seal, sha256, SubmitFleetError, unseal } from './util.js';

export type Role = 'owner' | 'agent';

export interface Actor {
  workspaceId: string;
  role: Role;
  /** Stable principal id, e.g. the API key id. */
  id: string;
}

export async function createWorkspace(db: Db, name: string): Promise<string> {
  const id = newId('wsp');
  await run(db, 'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', id, name, nowIso());
  return id;
}

export async function ensureDefaultWorkspace(db: Db): Promise<string> {
  const r = await one<{ id: string }>(db, 'SELECT id FROM workspaces ORDER BY created_at LIMIT 1');
  return r?.id ?? createWorkspace(db, 'default');
}

/** Returns the plaintext token once; only its hash is stored. */
export async function createApiKey(db: Db, workspaceId: string, role: Role, label: string): Promise<{ id: string; token: string }> {
  const id = newId('key');
  const token = `sf_${role === 'owner' ? 'own' : 'agt'}_${randomBytes(24).toString('base64url')}`;
  await run(db, 'INSERT INTO api_keys (id, workspace_id, role, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, workspaceId, role, label, sha256(token), nowIso());
  return { id, token };
}

export async function authenticate(db: Db, token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;
  const r = await one<{ id: string; workspace_id: string; role: Role; expires_at: string | null; last_used_at: string | null; user_id: string | null }>(
    db,
    'SELECT id, workspace_id, role, expires_at, last_used_at, user_id FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL',
    sha256(token),
  );
  if (!r || (r.expires_at && Date.parse(r.expires_at) <= Date.now())) return null;
  // Coarse last-used stamp (once a minute) so a busy agent does not write on every call.
  if (!r.last_used_at || Date.now() - Date.parse(r.last_used_at) > 60_000) await run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), r.id);
  // A token issued to a signed-in person (CLI login) acts as that person; other keys act as themselves.
  return { id: r.user_id ? `user:${r.user_id}` : r.id, workspaceId: r.workspace_id, role: r.role };
}

export async function revokeApiKey(db: Db, workspaceId: string, id: string): Promise<void> {
  const n = await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL', nowIso(), id, workspaceId);
  if (!n) throw new SubmitFleetError('not_found', 'key');
}

/** Long-lived keys a person made for agents and scripts (OAuth access tokens are not listed). */
export async function listApiKeys(db: Db, workspaceId: string) {
  return all(db, "SELECT id, role, label, created_at, last_used_at FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL AND label NOT LIKE 'oauth:%' ORDER BY created_at DESC", workspaceId);
}

export function requireOwner(actor: Actor): void {
  if (actor.role !== 'owner') throw new SubmitFleetError('owner_required', 'this operation needs the owner, not an agent');
}

// ── Global pause ─────────────────────────────────────────────────────────────

export async function setPaused(db: Db, workspaceId: string, paused: boolean): Promise<void> {
  await run(db, 'UPDATE workspaces SET paused = ?, paused_at = ? WHERE id = ?', paused ? 1 : 0, paused ? nowIso() : null, workspaceId);
}

export async function isPaused(db: Db, workspaceId: string): Promise<boolean> {
  const r = await one<{ paused: number }>(db, 'SELECT paused FROM workspaces WHERE id = ?', workspaceId);
  return Number(r?.paused) === 1;
}

// ── Destination accounts ─────────────────────────────────────────────────────

export interface Account {
  id: string;
  workspace_id: string;
  destination_id: string;
  label: string;
  status: 'pending' | 'connected' | 'needs_reauth' | 'disconnected';
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const ACCOUNT_COLS = 'id, workspace_id, destination_id, label, status, expires_at, created_at, updated_at';

export async function connectAccount(
  db: Db,
  key: Buffer,
  workspaceId: string,
  destinationId: string,
  label: string,
  secret: Record<string, string>,
  expiresAt: string | null,
): Promise<Account> {
  const now = nowIso();
  const existing = await one<{ id: string }>(db, 'SELECT id FROM accounts WHERE workspace_id = ? AND destination_id = ? AND label = ?', workspaceId, destinationId, label);
  const sealed = seal(key, JSON.stringify(secret));
  let id = existing?.id;
  if (id) {
    await run(db, "UPDATE accounts SET sealed_secret = ?, status = 'connected', expires_at = ?, updated_at = ? WHERE id = ?", sealed, expiresAt, now, id);
  } else {
    id = newId('acc');
    await run(
      db,
      "INSERT INTO accounts (id, workspace_id, destination_id, label, status, sealed_secret, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?)",
      id, workspaceId, destinationId, label, sealed, expiresAt, now, now,
    );
  }
  return (await getAccount(db, workspaceId, id))!;
}

export async function getAccount(db: Db, workspaceId: string, id: string): Promise<Account | null> {
  return one<Account>(db, `SELECT ${ACCOUNT_COLS} FROM accounts WHERE workspace_id = ? AND id = ?`, workspaceId, id);
}

export async function listAccounts(db: Db, workspaceId: string): Promise<Account[]> {
  return all<Account>(db, `SELECT ${ACCOUNT_COLS} FROM accounts WHERE workspace_id = ? ORDER BY created_at`, workspaceId);
}

export async function usableAccount(db: Db, workspaceId: string, destinationId: string, now = Date.now()): Promise<Account | null> {
  const rows = await all<Account>(
    db,
    `SELECT ${ACCOUNT_COLS} FROM accounts WHERE workspace_id = ? AND destination_id = ? AND status = 'connected' ORDER BY created_at`,
    workspaceId,
    destinationId,
  );
  return rows.find((a) => !a.expires_at || Date.parse(a.expires_at) > now) ?? null;
}

/** Disconnect wipes the sealed secret; queued work for the account can no longer be claimed. */
export async function disconnectAccount(db: Db, workspaceId: string, id: string): Promise<void> {
  const n = await run(db, "UPDATE accounts SET status = 'disconnected', sealed_secret = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?", nowIso(), id, workspaceId);
  if (!n) throw new SubmitFleetError('not_found', `account ${id}`);
}

export async function markNeedsReauth(db: Db, id: string): Promise<void> {
  await run(db, "UPDATE accounts SET status = 'needs_reauth', updated_at = ? WHERE id = ?", nowIso(), id);
}

export async function readAccountSecret(db: Db, key: Buffer, workspaceId: string, id: string): Promise<Record<string, string>> {
  const r = await one<{ sealed_secret: string | null; status: string }>(db, 'SELECT sealed_secret, status FROM accounts WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!r || !r.sealed_secret || r.status !== 'connected') throw new SubmitFleetError('account_unavailable');
  return JSON.parse(unseal(key, r.sealed_secret)) as Record<string, string>;
}
