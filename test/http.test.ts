import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http.js';
import { createApiKey } from '../src/workspaces.js';
import { approvedProduct, harness, seedDestinations, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

async function setup() {
  h = await harness();
  const owner = await createApiKey(h.fleet.db, h.owner.workspaceId, 'owner', 'http owner');
  const agent = await createApiKey(h.fleet.db, h.owner.workspaceId, 'agent', 'http agent');
  const app = buildApp(h.fleet);
  const call = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { app, call, owner: owner.token, agent: agent.token };
}

const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const mcpHeaders = { accept: 'application/json, text/event-stream' };

describe('HTTP API', () => {
  it('requires a key and scopes everything to its workspace', async () => {
    const { call, owner } = await setup();
    expect((await call(null, 'GET', '/api/v1/products')).status).toBe(401);
    expect((await call('sf_own_bogus', 'GET', '/api/v1/products')).status).toBe(401);
    const res = await call(owner, 'GET', '/api/v1/whoami');
    expect(await res.json()).toMatchObject({ role: 'owner', workspace_id: h.owner.workspaceId });
  });

  it('runs plan -> approval request (agent) -> approve (owner only) -> run', async () => {
    const { call, owner, agent } = await setup();
    await seedDestinations(h.fleet, h.owner, 2);
    const p = await approvedProduct(h.fleet, h.owner);
    const planRes = await call(agent, 'POST', '/api/v1/campaigns', { product_id: p.id, min_executable_destinations: 2 });
    expect(planRes.status).toBe(201);
    const plan = (await planRes.json()) as { campaign: { id: string } };
    const id = plan.campaign.id;
    const req = (await (await call(agent, 'POST', `/api/v1/campaigns/${id}/approval-request`)).json()) as { scope_hash: string };
    const denied = await call(agent, 'POST', `/api/v1/campaigns/${id}/approve`, { scope_hash: req.scope_hash });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'owner_required' });
    expect((await call(owner, 'POST', `/api/v1/campaigns/${id}/approve`, { scope_hash: req.scope_hash })).status).toBe(200);
    expect(await (await call(agent, 'POST', `/api/v1/campaigns/${id}/run`)).json()).toMatchObject({ queued: 2 });
    await h.fleet.worker().tick();
    const md = await call(owner, 'GET', `/api/v1/reports/${id}?format=markdown`);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(await md.text()).toContain('# SubmitFleet campaign report');
  });

  it('a strict campaign below the minimum is a 409 with the real count', async () => {
    const { call, agent } = await setup();
    await seedDestinations(h.fleet, h.owner, 3);
    const p = await approvedProduct(h.fleet, h.owner);
    const plan = (await (await call(agent, 'POST', '/api/v1/campaigns', { product_id: p.id, mode: 'auto_only' })).json()) as { campaign: { id: string; status: string }; counts: { executable: number } };
    expect(plan.campaign.status).toBe('coverage_insufficient');
    expect(plan.counts.executable).toBe(3);
    const r = await call(agent, 'POST', `/api/v1/campaigns/${plan.campaign.id}/approval-request`);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'coverage_insufficient', detail: { executable: 3, required: 100 } });
  });

  it('rejects cross-origin browser calls and validates bodies', async () => {
    const { call, owner } = await setup();
    expect((await call(owner, 'GET', '/api/v1/products', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    // Behind nginx: the app sees http://127.0.0.1 but the browser's https origin matches the forwarded host.
    const proxied = await call(owner, 'POST', '/api/v1/pause', undefined, { origin: 'https://submitfleet.com', 'x-forwarded-host': 'submitfleet.com' });
    expect(proxied.status).toBe(200);
    expect((await call(owner, 'POST', '/api/v1/pause', undefined, { origin: 'https://evil.example', 'x-forwarded-host': 'submitfleet.com' })).status).toBe(403);
    const bad = await call(owner, 'POST', '/api/v1/products', { url: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
  });

  it('serves the installer as a shell script', async () => {
    const { app } = await setup();
    const sh = await app.request('/install.sh');
    expect(sh.headers.get('content-type')).toContain('shellscript');
    expect(await sh.text()).toMatch(/^#!\/bin\/sh/);
  });
});

describe('MCP over Streamable HTTP', () => {
  it('lists submitfleet_ tools with cache metadata and no approval-granting tool', async () => {
    const { call, agent } = await setup();
    const init = await call(agent, 'POST', '/mcp', rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }), mcpHeaders);
    expect(init.status).toBe(200);
    const res = await call(agent, 'POST', '/mcp', rpc('tools/list', {}, 2), mcpHeaders);
    const j = (await res.json()) as { result: { tools: { name: string }[]; ttlMs: number; cacheScope: string } };
    const names = j.result.tools.map((t) => t.name);
    expect(names.every((n) => n.startsWith('submitfleet_'))).toBe(true);
    for (const n of ['submitfleet_coverage_report', 'submitfleet_campaign_plan', 'submitfleet_approval_request', 'submitfleet_report_export']) expect(names).toContain(n);
    expect(names.some((n) => /approve|grant/.test(n))).toBe(false);
    expect(j.result.ttlMs).toBeGreaterThanOrEqual(0);
    expect(['public', 'private']).toContain(j.result.cacheScope);
    expect((await call(null, 'POST', '/mcp', rpc('tools/list'), mcpHeaders)).status).toBe(401);
  });

  it('tool errors carry reason codes and no external action', async () => {
    const { call, agent } = await setup();
    const res = await call(agent, 'POST', '/mcp', rpc('tools/call', { name: 'submitfleet_campaign_status', arguments: { campaign_id: 'cmp_missing' } }, 3), mcpHeaders);
    const j = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(j.result.isError).toBe(true);
    expect(JSON.parse(j.result.content[0]!.text)).toMatchObject({ error: 'not_found', external_action_performed: false });
  });
});
