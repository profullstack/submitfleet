import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mailer } from './mail.js';
import { mountWeb, resolveActor, sameOrigin, WEB_ROOT } from './web.js';
import { buildMcpServer } from './mcp.js';
import { createCrawlGate, type CrawlGate } from './crawl-gate.js';
import { x402Gateway } from '@profullstack/x402-gateway/hono';
import type { SubmitFleet } from './service.js';
import { SubmitFleetError } from './util.js';
import { createProfileStore, mountProfileRoutes } from '@profullstack/profile';
import { getUser } from './auth.js';
import type { Actor } from './workspaces.js';

type Env = { Variables: { actor: Actor } };

const STATUS: Record<string, number> = {
  not_found: 404,
  owner_required: 403,
  unauthorized: 401,
  invalid_request: 400,
  validation_failed: 400,
  invalid_url_scheme: 400,
  canonical_identity_immutable: 409,
  product_exists: 409,
  product_has_submissions: 409,
  coverage_insufficient: 409,
  approval_invalidated: 409,
  no_pending_approval: 409,
  not_approved: 409,
  invalid_state: 409,
  invalid_transition: 409,
  campaign_not_replannable: 409,
  unsupported_operation: 409,
  secret_key_missing: 503,
  origin_not_allowed: 403,
  invalid_credentials: 401,
  locked: 429,
  rate_limited: 429,
  link_invalid: 400,
  weak_password: 400,
  passkey_failed: 400,
  url_not_public: 400,
  url_unresolvable: 400,
  fetch_failed: 502,
  mail_unavailable: 503,
};

const productBody = z.object({
  url: z.string().url().optional(),
  name: z.string().max(200).nullable().optional(),
  tagline: z.string().max(200).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  categories: z.array(z.string().max(100)).max(50).optional(),
  contact_email: z.string().email().nullable().optional(),
  logo_path: z.string().max(500).nullable().optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  destination_fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

const planBody = z.object({
  product_id: z.string(),
  min_executable_destinations: z.number().int().min(1).optional(),
  spend_limit_cents: z.number().int().min(0).optional(),
  earliest_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  latest_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  release_scope: z.string().max(100).optional(),
  destinations: z.array(z.string()).max(1000).optional(),
  mode: z.enum(['all', 'auto_only']).optional(),
  channels: z.array(z.string().max(50)).max(20).optional(),
  include_unknown_pricing: z.boolean().optional(),
});

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SubmitFleetError('invalid_request', 'body must be JSON');
    }
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new SubmitFleetError('invalid_request', 'invalid body', r.error.issues);
  return r.data;
}

function bearer(c: Context): string | null {
  const h = c.req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function buildApp(fleet: SubmitFleet, opts: { allowedOrigins?: string[]; mailer?: Mailer; publicOrigin?: string; crawlGate?: CrawlGate | null } = {}): Hono<Env> {
  const app = new Hono<Env>();
  const allowed = new Set(opts.allowedOrigins ?? []);

  app.onError((err, c) => {
    if (err instanceof SubmitFleetError) {
      return c.json({ error: err.code, message: err.message, detail: err.detail ?? null }, (STATUS[err.code] ?? 400) as 400);
    }
    console.error('[submitfleet] unhandled', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on our own form POSTs.
    c.header('referrer-policy', 'same-origin');
    c.header('x-frame-options', 'DENY');
  });

  // Training crawlers buy a day pass before anything else is done for them.
  const crawlGate = opts.crawlGate !== undefined ? opts.crawlGate : createCrawlGate();
  if (crawlGate) app.use('*', x402Gateway(crawlGate));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const checks = await fleet.doctor();
    const ready = checks.find((x) => x.check === 'database')?.ok === true;
    return c.json({ ready, checks }, ready ? 200 : 503);
  });
  // The house npm-CLI installer (w3bs.org template): brings its own Node when the machine has none.
  const installSh = readFileSync(join(WEB_ROOT, 'install.sh'), 'utf8');
  app.get('/install.sh', (c) => c.body(installSh, 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' }));
  // Bearer tokens (agents, CLI) or the browser session. A cookie-authenticated write must
  // come from our own pages (CSRF); cross-site browser calls are refused either way.
  const auth = async (c: Context<Env>, next: () => Promise<void>) => {
    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin) && !sameOrigin(c)) return c.json({ error: 'origin_not_allowed' }, 403);
    const r = await resolveActor(fleet, c);
    if (!r) return c.json({ error: 'unauthorized' }, 401);
    if (r.viaCookie && !['GET', 'HEAD'].includes(c.req.method) && !sameOrigin(c)) return c.json({ error: 'origin_not_allowed' }, 403);
    c.set('actor', r.actor);
    await next();
  };
  const originGuard = async (_c: Context<Env>, next: () => Promise<void>) => next();

  mountWeb(app, fleet, { mailer: opts.mailer ?? (async () => {}), publicOrigin: opts.publicOrigin });

  // ── MCP over Streamable HTTP (stateless: one server per request) ──
  app.all('/mcp', originGuard, auth, async (c) => {
    const server = buildMcpServer(fleet, c.get('actor'));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  const api = new Hono<Env>();
  api.use('*', originGuard, auth);
  const A = (c: Context<Env>) => c.get('actor');
  const page = (c: Context) => ({ limit: Math.min(Number(c.req.query('limit') ?? 100) || 100, 500), offset: Number(c.req.query('offset') ?? 0) || 0 });

  // GET/PUT/PATCH /api/v1/me/profile: the signed-in person's profile (session or a user's token).
  mountProfileRoutes(api, {
    path: '/me/profile',
    store: createProfileStore(fleet.db),
    getUser: async (_req: Request, c: Context<Env>) => {
      const id = c.get('actor').id;
      const user = id.startsWith('user:') ? await getUser(fleet.db, id.slice(5)) : null;
      return user ? { id: user.id, email: user.email } : null;
    },
  });

  api.get('/whoami', (c) => c.json({ workspace_id: A(c).workspaceId, role: A(c).role, key_id: A(c).id }));

  api.get('/products', async (c) => c.json(await fleet.productList(A(c), page(c).limit, page(c).offset)));
  api.post('/products', async (c) => {
    const b = await body(c, productBody.extend({ url: z.string().url() }));
    return c.json(await fleet.productCreate(A(c), b as never), 201);
  });
  api.get('/products/:id', async (c) => c.json(await fleet.productGet(A(c), c.req.param('id'))));
  api.patch('/products/:id', async (c) => c.json(await fleet.productUpdate(A(c), c.req.param('id'), (await body(c, productBody)) as never)));
  api.delete('/products/:id', async (c) => {
    await fleet.productDelete(A(c), c.req.param('id'));
    return c.json({ deleted: c.req.param('id'), remote_listings_deleted: false });
  });
  api.post('/products/:id/approve-facts', async (c) => c.json(await fleet.productApproveFacts(A(c), c.req.param('id'))));

  api.get('/catalog', async (c) => {
    const list = (k: string) => (c.req.query(k) ? c.req.query(k)!.split(',').filter(Boolean) : undefined);
    if (c.req.query('product')) return c.json(await fleet.catalogForProduct(A(c), c.req.query('product')!, { channels: list('channel'), pricing: list('pricing'), query: c.req.query('q') }));
    return c.json(await fleet.catalogSearch(c.req.query('q'), page(c).limit, page(c).offset, { channels: list('channel'), pricing: list('pricing') }));
  });
  api.get('/catalog/:slug', async (c) => c.json(await fleet.catalogGet(c.req.param('slug'))));
  api.post('/catalog/import', async (c) => {
    const b = await body(c, z.object({ source: z.string(), license: z.string(), records: z.array(z.object({ name: z.string(), url: z.string().url(), kind: z.string().optional(), categories: z.array(z.string()).optional(), labeled_free: z.boolean().optional() })).max(5000) }));
    return c.json(await fleet.catalogImport(A(c), b.records, b.source, b.license));
  });
  api.post('/catalog/:slug/health', async (c) => {
    const b = await body(c, z.object({ health: z.enum(['healthy', 'quarantined', 'broken']), reason: z.string().min(1).max(500) }));
    await fleet.catalogSetHealth(A(c), c.req.param('slug'), b.health, b.reason);
    return c.json(await fleet.catalogGet(c.req.param('slug')));
  });
  api.get('/coverage', async (c) => c.json(await fleet.coverageReport()));

  api.get('/campaigns', async (c) => c.json(await fleet.campaignList(A(c))));
  const plan = (c: Context<Env>, b: z.infer<typeof planBody>, id?: string) =>
    fleet.campaignPlan(A(c), { productId: b.product_id, minExecutableDestinations: b.min_executable_destinations, spendLimitCents: b.spend_limit_cents, earliestDate: b.earliest_date, latestDate: b.latest_date, releaseScope: b.release_scope, destinations: b.destinations, mode: b.mode, channels: b.channels, includeUnknownPricing: b.include_unknown_pricing }, id);
  api.post('/campaigns', async (c) => c.json(await plan(c, await body(c, planBody)), 201));
  api.post('/campaigns/:id/plan', async (c) => c.json(await plan(c, await body(c, planBody), c.req.param('id'))));
  api.get('/campaigns/:id/preview', async (c) => c.json(await fleet.campaignPreview(A(c), c.req.param('id'))));
  api.post('/campaigns/:id/approval-request', async (c) => c.json(await fleet.approvalRequest(A(c), c.req.param('id'))));
  api.post('/campaigns/:id/approve', async (c) => {
    const b = await body(c, z.object({ scope_hash: z.string().length(64) }));
    return c.json(await fleet.approvalGrant(A(c), c.req.param('id'), b.scope_hash));
  });
  api.post('/campaigns/:id/run', async (c) => c.json(await fleet.campaignRun(A(c), c.req.param('id'))));
  api.get('/campaigns/:id/status', async (c) => c.json(await fleet.campaignStatus(A(c), c.req.param('id'))));
  api.post('/campaigns/:id/pause', async (c) => {
    await fleet.campaignPause(A(c), c.req.param('id'));
    return c.json({ paused: c.req.param('id') });
  });
  api.post('/campaigns/:id/cancel', async (c) => c.json({ ...(await fleet.campaignCancel(A(c), c.req.param('id'))), remote_listings_deleted: false }));

  api.get('/pause', async (c) => c.json({ paused: await fleet.pausedState(A(c)) }));
  api.post('/pause', async (c) => {
    await fleet.pauseAll(A(c));
    return c.json({ paused: true });
  });
  api.post('/resume', async (c) => {
    await fleet.resumeAll(A(c));
    return c.json({ paused: false });
  });

  api.get('/accounts', async (c) => c.json(await fleet.accountStatus(A(c))));
  api.post('/accounts/connect/start', async (c) => {
    const b = await body(c, z.object({ destination: z.string(), email: z.string().email() }));
    return c.json(await fleet.accountConnectStart(A(c), b.destination, b.email));
  });
  api.post('/accounts/connect/finish', async (c) => {
    const b = await body(c, z.object({ destination: z.string(), email: z.string().email(), code: z.string().regex(/^\d{4,8}$/), label: z.string().max(100).optional() }));
    return c.json(await fleet.accountConnectFinish(A(c), b.destination, b.email, b.code, b.label));
  });
  api.delete('/accounts/:id', async (c) => {
    await fleet.accountDisconnect(A(c), c.req.param('id'));
    return c.json({ disconnected: c.req.param('id') });
  });

  api.get('/human-queue', async (c) => c.json(await fleet.humanQueue(A(c))));
  api.get('/submissions/:id', async (c) => c.json(await fleet.submissionGet(A(c), c.req.param('id'))));
  api.post('/submissions/:id/reconcile', async (c) => c.json({ state: await fleet.submissionReconcile(A(c), c.req.param('id')) }));
  api.post('/submissions/:id/requeue', async (c) => c.json({ requeued: await fleet.submissionRequeue(A(c), c.req.param('id')) }));
  api.post('/submissions/:id/update', async (c) => c.json(await fleet.submissionUpdate(A(c), c.req.param('id')), 409));
  api.post('/submissions/:id/withdraw', async (c) => c.json(await fleet.submissionWithdraw(A(c), c.req.param('id')), 409));

  api.get('/reports/:campaignId', async (c) => {
    const format = (c.req.query('format') ?? 'json') as 'markdown' | 'json' | 'csv';
    if (!['markdown', 'json', 'csv'].includes(format)) throw new SubmitFleetError('invalid_request', 'format must be markdown, json or csv');
    const out = await fleet.reportExport(A(c), c.req.param('campaignId'), format);
    const type = format === 'markdown' ? 'text/markdown' : format === 'csv' ? 'text/csv' : 'application/json';
    return c.body(out, 200, { 'content-type': `${type}; charset=utf-8` });
  });
  api.post('/effort', async (c) => {
    const b = await body(c, z.object({ campaign_id: z.string().nullable(), activity: z.string().max(200), minutes: z.number().min(0).max(10_000), note: z.string().max(1000).optional() }));
    await fleet.logEffort(A(c), b.campaign_id, b.activity, b.minutes, b.note);
    return c.json({ ok: true });
  });

  api.post('/products/extract', async (c) => {
    const b = await body(c, z.object({ url: z.string().url().max(2000) }));
    return c.json(await fleet.productExtract(b.url));
  });
  api.put('/products/:id/logo', async (c) => {
    const bytes = Buffer.from(await c.req.arrayBuffer());
    return c.json(await fleet.productSetLogo(A(c), c.req.param('id'), bytes, c.req.header('content-type') ?? ''));
  });
  api.post('/products/:id/logo/from-url', async (c) => {
    const b = await body(c, z.object({ url: z.string().url().max(2000).optional(), urls: z.array(z.string().url().max(2000)).max(10).optional() }));
    const urls = b.urls ?? (b.url ? [b.url] : []);
    if (!urls.length) throw new SubmitFleetError('invalid_request', 'url or urls is required');
    return c.json(await fleet.productLogoFromCandidates(A(c), c.req.param('id'), urls));
  });
  api.get('/catalog-stats', async (c) => c.json(await fleet.catalogStats()));
  api.get('/campaigns/:id/queue', async (c) => c.json(await fleet.campaignQueue(A(c), c.req.param('id'))));
  api.get('/submissions/:id/kit', async (c) => c.json(await fleet.submissionKit(A(c), c.req.param('id'))));
  api.post('/submissions/:id/mark', async (c) => {
    const b = await body(c, z.object({ action: z.enum(['submitted', 'live', 'rejected', 'skipped']), listing_url: z.string().max(2000).nullable().optional(), note: z.string().max(2000).nullable().optional() }));
    return c.json(await fleet.submissionMark(A(c), c.req.param('id'), b.action, { listing_url: b.listing_url, note: b.note }));
  });
  api.get('/keys', async (c) => c.json(await fleet.apiKeyList(A(c))));
  api.post('/keys', async (c) => {
    const b = await body(c, z.object({ role: z.enum(['owner', 'agent']), label: z.string().max(80) }));
    return c.json(await fleet.apiKeyCreate(A(c), b.role, b.label), 201);
  });
  api.delete('/keys/:id', async (c) => {
    await fleet.apiKeyRevoke(A(c), c.req.param('id'));
    return c.json({ revoked: c.req.param('id') });
  });

  app.route('/api/v1', api);
  return app;
}
