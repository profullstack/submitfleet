import { afterEach, describe, expect, it } from 'vitest';
import { bytesToBase64 } from '@profullstack/sealed-secrets';
import { all, run } from '../src/db.js';
import { seal as legacySeal } from '../src/util.js';
import { loadSecretKey } from '../src/util.js';
import { sealer } from '../src/vault.js';
import { approvedProduct, fakeAdapter, harness, launch, qualifyingDestination, SECRET, vaultUp, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

const TOKEN = ['tok', 'fixture', 'value'].join('-');

describe('workspace key vault: unlock-on-use', () => {
  it('no vault = no credentials stored at all', async () => {
    h = await harness();
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login' }));
    await expect(h.fleet.accountConnectSecret(h.owner, 'dest-0', 'main', { access_token: TOKEN }, null)).rejects.toMatchObject({ code: 'vault_missing' });
    expect(await all(h.fleet.db, 'SELECT id FROM accounts')).toHaveLength(0);
  });

  it('sealed at rest; the server key (SUBMITFLEET_SECRET_KEY) cannot open it; only an owner can unlock', async () => {
    h = await harness();
    const made = await vaultUp(h.fleet, h.owner);
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login' }));
    await h.fleet.accountConnectSecret(h.owner, 'dest-0', 'main', { access_token: TOKEN }, null);
    const [row] = await all<{ sealed_secret: string }>(h.fleet.db, 'SELECT sealed_secret FROM accounts');
    expect(row!.sealed_secret.startsWith('v2.')).toBe(true);
    expect(row!.sealed_secret).not.toContain(TOKEN);
    await expect(h.fleet.vaultUnlock(h.agent, bytesToBase64(made.dek))).rejects.toMatchObject({ code: 'owner_required' });
    await expect(h.fleet.vaultUnlock(h.owner, bytesToBase64(new Uint8Array(32)))).rejects.toMatchObject({ code: 'vault_key_invalid' });
    const st = await h.fleet.vaultStatus(h.owner);
    expect(st).toMatchObject({ exists: true, unlocked: true });
  });

  it('a restart locks: account work waits queued, then runs after unlock; lock stops it again', async () => {
    let seen = '';
    const adapter = fakeAdapter('fake', {});
    const orig = adapter.execute.bind(adapter);
    adapter.execute = async (ctx) => {
      seen = (await ctx.credentials()).access_token ?? '';
      return orig(ctx);
    };
    h = await harness([adapter]);
    const made = await vaultUp(h.fleet, h.owner);
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login' }));
    await h.fleet.accountConnectSecret(h.owner, 'dest-0', 'main', { access_token: TOKEN }, null);
    const p = await approvedProduct(h.fleet, h.owner);
    await launch(h, p.id, 1);

    const restarted = await h.reopen([adapter].reduce((m, a) => m.set(a.id, a), new Map()));
    expect((await restarted.vaultStatus(h.owner)).unlocked).toBe(false);
    await restarted.worker().tick(3);
    expect((await all<{ state: string }>(restarted.db, 'SELECT state FROM intents')).map((r) => r.state)).toEqual(['queued']);
    expect(seen).toBe('');

    await restarted.vaultUnlock(h.owner, bytesToBase64(made.dek), '1h');
    await restarted.worker().tick(3);
    expect(seen).toBe(TOKEN);
    expect((await all<{ state: string }>(restarted.db, 'SELECT state FROM intents')).map((r) => r.state)).toEqual(['submitted']);
    expect(await restarted.vaultLock(h.owner)).toEqual({ unlocked: false, expires_at: null });
  });

  it('legacy v1 rows move into the vault on unlock; LEGACY_KEY_MIGRATION=off leaves them', async () => {
    h = await harness();
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login' }));
    const made = await sealer.createSeal('test vault passphrase', h.owner.workspaceId);
    await h.fleet.vaultCreate(h.owner, made.seal);
    const [d] = await all<{ id: string }>(h.fleet.db, 'SELECT id FROM destinations');
    const v1 = legacySeal(loadSecretKey(SECRET), JSON.stringify({ access_token: TOKEN }));
    await run(h.fleet.db, "INSERT INTO accounts (id, workspace_id, destination_id, label, status, sealed_secret, created_at, updated_at) VALUES ('acc_l', ?, ?, 'legacy', 'connected', ?, 'x', 'x')", h.owner.workspaceId, d!.id, v1);

    process.env.LEGACY_KEY_MIGRATION = 'off';
    expect((await h.fleet.vaultUnlock(h.owner, bytesToBase64(made.dek))).legacy_migrated).toBe(0);
    delete process.env.LEGACY_KEY_MIGRATION;
    expect((await h.fleet.vaultUnlock(h.owner, bytesToBase64(made.dek))).legacy_migrated).toBe(1);
    const [row] = await all<{ sealed_secret: string }>(h.fleet.db, 'SELECT sealed_secret FROM accounts');
    expect(row!.sealed_secret.startsWith('v2.')).toBe(true);
    expect(await h.fleet.vaults.openSecret(h.owner.workspaceId, row!.sealed_secret)).toEqual({ access_token: TOKEN });
  });
});
