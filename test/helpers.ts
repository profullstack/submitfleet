import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Adapter, ExecContext, ExecResult, ReconcileResult } from '../src/adapters/types.js';
import type { DestinationInput } from '../src/catalog.js';
import { SubmitFleet, type SubmitFleetConfig } from '../src/service.js';
import { createApiKey, ensureDefaultWorkspace, type Actor } from '../src/workspaces.js';

export const SECRET = randomBytes(32).toString('base64');

export interface FakeBehaviour {
  execute?: (ctx: ExecContext) => Promise<ExecResult>;
  reconcile?: (ctx: ExecContext) => Promise<ReconcileResult>;
  capabilities?: Partial<ReturnType<Adapter['capabilities']>>;
}

export function fakeAdapter(id = 'fake', b: FakeBehaviour = {}): Adapter & { calls: { execute: string[]; reconcile: string[] } } {
  const calls = { execute: [] as string[], reconcile: [] as string[] };
  return {
    id,
    version: '1.0.0',
    destinationSlug: '*',
    method: 'api',
    calls,
    capabilities: () => ({ update: false, withdraw: false, reconcile: 'tested', ...b.capabilities }),
    validate: (p) => (p.name ? [] : [{ field: 'name', code: 'missing_fact', message: 'name required' }]),
    prepare: async ({ product, destination }) => ({ name: product.name, url: product.url, to: destination.slug, _estimated_cost_cents: 0 }),
    preflight: async () => ({ ok: true }),
    execute: async (ctx) => {
      calls.execute.push(ctx.intentId);
      if (b.execute) return b.execute(ctx);
      return { kind: 'submitted', remoteId: `r-${ctx.intentId}`, receiptId: `rcpt-${ctx.intentId}`, listingUrl: `https://${ctx.destination.canonical_domain}/p/1`, evidence: { ok: true } };
    },
    reconcile: async (ctx) => {
      calls.reconcile.push(ctx.intentId);
      if (b.reconcile) return b.reconcile(ctx);
      return { status: 'absent', evidence: {} };
    },
  };
}

export function qualifyingDestination(i: number, over: Partial<DestinationInput> = {}): DestinationInput {
  const now = new Date().toISOString();
  return {
    slug: `dest-${i}`,
    name: `Destination ${i}`,
    canonical_domain: `dest-${i}.example`,
    kind: 'directory',
    listing_group: `dest-${i}.example`,
    account_requirement: 'none',
    fee_status: 'verified_free',
    fee_evidence_url: `https://dest-${i}.example/pricing`,
    fee_checked_at: now,
    automation_method: 'api',
    automation_permission: 'permitted',
    permission_evidence: 'documented public API',
    permission_checked_at: now,
    challenge_policy: 'none',
    quality_decision: 'accepted',
    quality_basis: 'relevant software directory with substantive listings',
    adapter_id: 'fake',
    adapter_version: '1.0.0',
    adapter_health: 'healthy',
    contract_tested_at: now,
    live_tested_at: now,
    live_evidence_ref: `evidence/dest-${i}.json`,
    reconcile_support: 'tested',
    ...over,
  };
}

export interface Harness {
  fleet: SubmitFleet;
  owner: Actor;
  agent: Actor;
  dir: string;
  dbUrl: string;
  reopen: (adapters?: Map<string, Adapter>) => Promise<SubmitFleet>;
  cleanup: () => void;
}

export async function harness(adapters: Adapter[] = [fakeAdapter()], extra: Partial<SubmitFleetConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'submitfleet-test-'));
  writeFileSync(join(dir, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const dbUrl = `file:${join(dir, 'sf.db')}`;
  const map = new Map(adapters.map((a) => [a.id, a]));
  const fleet = await SubmitFleet.open({ dbUrl, secretKey: SECRET, assetsDir: dir, adapters: map, ...extra });
  const ws = await ensureDefaultWorkspace(fleet.db);
  const ownerKey = await createApiKey(fleet.db, ws, 'owner', 'test owner');
  const agentKey = await createApiKey(fleet.db, ws, 'agent', 'test agent');
  const opened: SubmitFleet[] = [fleet];
  return {
    fleet,
    owner: { workspaceId: ws, role: 'owner', id: ownerKey.id },
    agent: { workspaceId: ws, role: 'agent', id: agentKey.id },
    dir,
    dbUrl,
    reopen: async (a = map) => {
      const f = await SubmitFleet.open({ dbUrl, secretKey: SECRET, assetsDir: dir, adapters: a });
      opened.push(f);
      return f;
    },
    cleanup: () => {
      for (const f of opened) f.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function seedDestinations(fleet: SubmitFleet, owner: Actor, n: number, over: (i: number) => Partial<DestinationInput> = () => ({})) {
  for (let i = 0; i < n; i++) await fleet.catalogUpsert(owner, qualifyingDestination(i, over(i)));
}

export async function approvedProduct(fleet: SubmitFleet, owner: Actor, url = 'https://acme.example/') {
  const p = await fleet.productCreate(owner, { url, name: 'Acme', tagline: 'The friendly to-do app', description: 'A to-do app.', logo_path: 'logo.png' });
  return fleet.productApproveFacts(owner, p.id);
}

/** Plan, request (as agent), grant (as owner) and run. */
export async function launch(h: Harness, productId: string, min: number, extra: Record<string, unknown> = {}) {
  const plan = await h.fleet.campaignPlan(h.agent, { productId, minExecutableDestinations: min, ...extra });
  await h.fleet.approvalRequest(h.agent, plan.campaign.id);
  await h.fleet.approvalGrant(h.owner, plan.campaign.id);
  await h.fleet.campaignRun(h.owner, plan.campaign.id);
  return plan;
}
