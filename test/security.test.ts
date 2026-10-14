import { afterEach, describe, expect, it } from 'vitest';
import { all } from '../src/db.js';
import { createApiKey, createWorkspace, authenticate } from '../src/workspaces.js';
import { redact, seal, unseal, loadSecretKey } from '../src/util.js';
import { approvedProduct, fakeAdapter, harness, launch, qualifyingDestination, SECRET, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

describe('9. secrets and tenant isolation', () => {
  it('account secrets are sealed at rest and never appear in submissions, events or reports', async () => {
    const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    const adapter = fakeAdapter('fake', {
      execute: async (ctx) => {
        const c = await ctx.credentials();
        expect(c.access_token).toBe(TOKEN);
        return { kind: 'submitted', remoteId: 'r', receiptId: 'rc', evidence: { authorization: `Bearer ${c.access_token}`, echoed: c.access_token } };
      },
    });
    h = await harness([adapter]);
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0, { account_requirement: 'login' }));
    await h.fleet.accountConnectSecret(h.owner, 'dest-0', 'main', { access_token: TOKEN, password: 'hunter2' }, null);
    const raw = await all<{ sealed_secret: string }>(h.fleet.db, 'SELECT sealed_secret FROM accounts');
    expect(raw[0]!.sealed_secret).not.toContain('hunter2');
    expect(JSON.stringify(await h.fleet.accountStatus(h.owner))).not.toMatch(/hunter2|eyJ|sealed/);

    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 1);
    await h.fleet.worker().tick();
    const [i] = await all<{ id: string }>(h.fleet.db, 'SELECT id FROM intents');
    const dump = JSON.stringify(await h.fleet.submissionGet(h.owner, i!.id)) + (await h.fleet.reportExport(h.owner, plan.campaign.id, 'json'));
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('hunter2');
  });

  it("another workspace's records cannot be read or changed", async () => {
    h = await harness();
    await h.fleet.catalogUpsert(h.owner, qualifyingDestination(0));
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = await launch(h, p.id, 1);
    const otherWs = await createWorkspace(h.fleet.db, 'other');
    const k = await createApiKey(h.fleet.db, otherWs, 'owner', 'other');
    const other = (await authenticate(h.fleet.db, k.token))!;
    expect(other.workspaceId).toBe(otherWs);
    await expect(h.fleet.productGet(other, p.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.fleet.campaignPreview(other, plan.campaign.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.fleet.campaignCancel(other, plan.campaign.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.fleet.reportGet(other, plan.campaign.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await h.fleet.productList(other)).toHaveLength(0);
    const [i] = await all<{ id: string }>(h.fleet.db, 'SELECT id FROM intents');
    await expect(h.fleet.submissionGet(other, i!.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await authenticate(h.fleet.db, 'sf_own_wrong')).toBeNull();
  });

  it('assets cannot escape the asset root or be executable', async () => {
    h = await harness();
    await expect(h.fleet.readAsset('../../etc/passwd')).rejects.toMatchObject({ code: 'asset_outside_root' });
    await expect(h.fleet.readAsset('/etc/passwd')).rejects.toMatchObject({ code: 'asset_outside_root' });
    await expect(h.fleet.readAsset('evil.sh')).rejects.toMatchObject({ code: 'asset_type_not_allowed' });
    expect((await h.fleet.readAsset('logo.png')).length).toBe(8);
  });

  it('seal/unseal round-trips and tampering fails', () => {
    const key = loadSecretKey(SECRET);
    const s = seal(key, 'secret');
    expect(unseal(key, s)).toBe('secret');
    const parts = s.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => unseal(key, parts.join('.'))).toThrow();
  });

  it('redact strips credential-like keys and JWTs', () => {
    expect(redact({ access_token: 'x', nested: { password: 'p', ok: 1 }, jwt: 'eyJa.eyJb.c' })).toEqual({ access_token: '[redacted]', nested: { password: '[redacted]', ok: 1 }, jwt: '[redacted]' });
  });
});
