/**
 * Workspace key vault (unlock-on-use fleet rule, 2026-10-28): no key stored on
 * our servers may open a customer's directory-account credentials.
 *
 * - The owner makes the vault where the passphrase is typed (the CLI or the
 *   app's Key vault card): PBKDF2-SHA256 600k -> HKDF -> AES-256-GCM data key,
 *   wrapped by the passphrase and a one-time recovery key, plus an inbox key
 *   pair. workspace_vaults keeps only that record.
 * - Account secrets are sealed to the vault's inbox public key ("v2." values in
 *   accounts.sealed_secret): the server can seal them, never open them.
 * - The worker opens them only while the owner has unlocked: the client sends
 *   the data key (never the passphrase); this process keeps it in memory for
 *   the TTL they picked (default 8h, max 7d). Restart, TTL or Lock: work that
 *   needs an account waits in the queue and resumes on the next unlock.
 * - Legacy "v1." rows (sealed with SUBMITFLEET_SECRET_KEY) are moved into the
 *   vault once, during the owner's unlock, unless LEGACY_KEY_MIGRATION=off.
 */
import { base64ToBytes, createSealer, isInboxEntry, isSealRecord, parseTtl, UnlockStore, wipe, type SealRecord } from '@profullstack/sealed-secrets';
import { all, one, run, type Db } from './db.js';
import { nowIso, SubmitFleetError, unseal } from './util.js';

export const sealer = createSealer({ app: 'submitfleet', scope: 'workspace_vault' });
export const SEALED_V2 = 'v2.';
const FIELD = 'account';

export const LOCKED_MESSAGE = 'locked: unlock your workspace key vault (submitfleet vault unlock) to resume account-based submissions';

export function legacyKeyMigrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LEGACY_KEY_MIGRATION ?? '').trim().toLowerCase() !== 'off';
}

export class Vaults {
  readonly sessions: UnlockStore;
  private readonly unlocked = new Set<string>();

  constructor(private readonly db: Db, private readonly legacyKey: Buffer | null, opts: { sessions?: UnlockStore } = {}) {
    this.sessions = opts.sessions ?? new UnlockStore();
    this.sessions.onChange((ws, isUnlocked) => {
      if (isUnlocked) this.unlocked.add(ws);
      else this.unlocked.delete(ws);
    });
  }

  /** Workspaces whose key is in memory right now (the worker only claims their account work). */
  unlockedWorkspaces(): string[] {
    return [...this.unlocked].filter((ws) => this.sessions.status(ws).unlocked);
  }

  async seal(workspaceId: string): Promise<SealRecord | null> {
    const r = await one<{ seal: string }>(this.db, 'SELECT seal FROM workspace_vaults WHERE workspace_id = ?', workspaceId);
    if (!r) return null;
    const seal = JSON.parse(r.seal);
    return isSealRecord(seal) ? seal : null;
  }

  async status(workspaceId: string) {
    const seal = await this.seal(workspaceId);
    const s = this.sessions.status(workspaceId);
    const legacy = await one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM accounts WHERE workspace_id = ? AND sealed_secret LIKE 'v1.%'", workspaceId);
    return { exists: Boolean(seal), seal, unlocked: s.unlocked, expires_at: s.expiresAt, legacy_unsealed: Number(legacy?.n ?? 0) };
  }

  async create(workspaceId: string, seal: unknown): Promise<void> {
    if (!isSealRecord(seal)) throw new SubmitFleetError('invalid_request', 'seal is not a seal record');
    if (await this.seal(workspaceId)) throw new SubmitFleetError('vault_exists', 'this workspace already has a key vault');
    await run(this.db, 'INSERT INTO workspace_vaults (workspace_id, seal, created_at) VALUES (?, ?, ?)', workspaceId, JSON.stringify(seal), nowIso());
  }

  /** The owner's unlock: check the data key against the vault, keep it in memory, migrate legacy rows once. */
  async unlock(workspaceId: string, dataKeyB64: string, ttl?: string | number | null) {
    const seal = await this.seal(workspaceId);
    if (!seal) throw new SubmitFleetError('vault_missing', 'create the workspace key vault first');
    let key: Uint8Array;
    try {
      key = base64ToBytes(dataKeyB64);
    } catch {
      throw new SubmitFleetError('vault_key_invalid', 'data_key is not base64');
    }
    try {
      if (key.length !== 32 || !(await sealer.verifyDataKey(key, seal, workspaceId))) throw new SubmitFleetError('vault_key_invalid', 'that key does not open this vault');
      const ttlSeconds = typeof ttl === 'number' ? ttl : typeof ttl === 'string' && ttl ? parseTtl(ttl) : undefined;
      const status = this.sessions.unlock(workspaceId, key, ttlSeconds);
      const migrated = await this.migrateLegacy(workspaceId, seal);
      return { unlocked: true, expires_at: status.expiresAt, legacy_migrated: migrated };
    } finally {
      wipe(key);
    }
  }

  lock(workspaceId: string) {
    this.sessions.lock(workspaceId);
    return { unlocked: false, expires_at: null };
  }

  /** Seal an account secret to the workspace inbox (no data key needed; the server cannot open it). */
  async sealSecret(workspaceId: string, secret: Record<string, string>): Promise<string> {
    const seal = await this.seal(workspaceId);
    if (!seal) throw new SubmitFleetError('vault_missing', 'create the workspace key vault first (submitfleet vault init): account credentials are sealed with a passphrase only you hold');
    const entry = await sealer.sealToInbox(seal.inbox_public_key, { [FIELD]: JSON.stringify(secret) }, workspaceId);
    return SEALED_V2 + JSON.stringify(entry);
  }

  /** Open an account secret. Throws vault_locked while the workspace is locked. */
  async openSecret(workspaceId: string, stored: string): Promise<Record<string, string>> {
    if (!stored.startsWith(SEALED_V2)) throw new SubmitFleetError('vault_locked', LOCKED_MESSAGE);
    const dek = this.sessions.get(workspaceId);
    const seal = await this.seal(workspaceId);
    if (!dek || !seal) throw new SubmitFleetError('vault_locked', LOCKED_MESSAGE);
    const entry = JSON.parse(stored.slice(SEALED_V2.length));
    if (!isInboxEntry(entry)) throw new SubmitFleetError('account_unavailable', 'sealed secret is malformed');
    const { patch } = await sealer.openInbox(dek, seal, [entry], workspaceId);
    return JSON.parse(patch[FIELD] ?? '{}') as Record<string, string>;
  }

  private async migrateLegacy(workspaceId: string, seal: SealRecord): Promise<number> {
    if (!this.legacyKey || !legacyKeyMigrationEnabled()) return 0;
    const rows = await all<{ id: string; sealed_secret: string }>(this.db, "SELECT id, sealed_secret FROM accounts WHERE workspace_id = ? AND sealed_secret LIKE 'v1.%'", workspaceId);
    let n = 0;
    for (const r of rows) {
      try {
        const entry = await sealer.sealToInbox(seal.inbox_public_key, { [FIELD]: unseal(this.legacyKey, r.sealed_secret) }, workspaceId);
        n += await run(this.db, 'UPDATE accounts SET sealed_secret = ?, updated_at = ? WHERE id = ? AND sealed_secret = ?', SEALED_V2 + JSON.stringify(entry), nowIso(), r.id, r.sealed_secret);
      } catch {
        // left for the next unlock
      }
    }
    return n;
  }
}
