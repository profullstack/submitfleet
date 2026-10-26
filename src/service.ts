import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKit } from './assisted.js';
import { relevance } from './relevance.js';
import { extractFacts, fetchPublic } from './extract.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { builtinAdapters } from './adapters/index.js';
import type { Adapter } from './adapters/types.js';
import { tinyLaunchRequestCode, tinyLaunchVerify } from './adapters/tinylaunch.js';
import * as campaigns from './campaigns.js';
import * as catalog from './catalog.js';
import { all, one, openDb, run, type Db } from './db.js';
import * as ledger from './ledger.js';
import * as products from './products.js';
import * as reports from './reports.js';
import { loadSecretKey, newId, nowIso, SubmitFleetError } from './util.js';
import { Worker } from './worker.js';
import { Rewards, rewardsDbPath } from './rewards.js';
import { dataDir } from './config.js';
import * as ws from './workspaces.js';
import type { Actor } from './workspaces.js';

export interface SubmitFleetConfig {
  dbUrl: string;
  dbAuthToken?: string;
  secretKey?: string;
  /** Product assets (logos, screenshots) are only read from inside this directory. */
  assetsDir: string;
  adapters?: Map<string, Adapter>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Public origin used in links handed to destinations (logo URLs) and in emails. */
  publicOrigin?: string;
  /** Fetch used for owner-supplied URLs (autofill, logo import); must refuse private addresses. */
  publicFetch?: typeof fetch;
}

const LOGO_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};
export const MAX_LOGO_BYTES = 1_000_000;

const MAX_ASSET_BYTES = 5 * 1024 * 1024;

export class SubmitFleet {
  readonly adapters: Map<string, Adapter>;
  readonly secretKey: Buffer | null;
  private fetchImpl: typeof fetch;
  private now: () => number;

  private constructor(
    readonly db: Db,
    readonly config: SubmitFleetConfig,
  ) {
    this.adapters = config.adapters ?? builtinAdapters();
    this.secretKey = config.secretKey ? loadSecretKey(config.secretKey) : null;
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
  }

  static async open(config: SubmitFleetConfig): Promise<SubmitFleet> {
    const db = await openDb({ url: config.dbUrl, authToken: config.dbAuthToken });
    return new SubmitFleet(db, config);
  }

  private rewardsInstance: Rewards | null = null;

  /** Credit codes, the Pro plan and invites (opened on first use). */
  get rewards(): Rewards {
    return (this.rewardsInstance ??= new Rewards(
      this.db,
      rewardsDbPath(this.config.dbUrl, join(dataDir(), 'rewards.db')),
      this.config.secretKey ?? 'submitfleet-local',
      this.now,
    ));
  }

  close(): void {
    this.rewardsInstance?.close();
    this.db.close();
  }

  readAsset = async (path: string): Promise<Buffer> => {
    const root = resolve(this.config.assetsDir);
    const full = resolve(root, path);
    if (!full.startsWith(root + sep)) throw new SubmitFleetError('asset_outside_root', path);
    if (/\.(exe|sh|bat|cmd|js|mjs|html?|svg)$/i.test(full)) throw new SubmitFleetError('asset_type_not_allowed', path);
    const s = await stat(full);
    if (s.size > MAX_ASSET_BYTES) throw new SubmitFleetError('asset_too_large', path);
    return readFile(full);
  };

  private planDeps() {
    return { adapters: this.adapters, readAsset: this.readAsset, now: this.now };
  }

  worker(opts: { workerId?: string; leaseMs?: number; execTimeoutMs?: number } = {}): Worker {
    return new Worker({ db: this.db, adapters: this.adapters, secretKey: this.secretKey, fetch: this.fetchImpl, now: this.now, ...opts });
  }

  // ── Products ──
  productCreate = (a: Actor, input: products.ProductInput) => products.createProduct(this.db, a.workspaceId, input);
  productGet = (a: Actor, id: string) => products.requireProduct(this.db, a.workspaceId, id);
  productList = (a: Actor, limit?: number, offset?: number) => products.listProducts(this.db, a.workspaceId, limit, offset);
  productUpdate = (a: Actor, id: string, patch: Partial<products.ProductInput>) => products.updateProduct(this.db, a.workspaceId, id, patch);
  productDelete = async (a: Actor, id: string) => {
    ws.requireOwner(a);
    return products.deleteProduct(this.db, a.workspaceId, id);
  };
  productApproveFacts = async (a: Actor, id: string) => {
    ws.requireOwner(a);
    return products.approveProductFacts(this.db, a.workspaceId, id, a.id);
  };

  // ── Catalog ──
  catalogSearch = (query?: string, limit?: number, offset?: number, filter: { channels?: string[]; pricing?: string[] } = {}) =>
    catalog.listDestinations(this.db, { query, limit, offset, ...filter });
  catalogGet = async (slug: string) => {
    const d = await catalog.getDestination(this.db, slug);
    if (!d) throw new SubmitFleetError('not_found', `destination ${slug}`);
    return { ...d, qualification: catalog.qualify(d, { installedAdapters: new Set(this.adapters.keys()), now: this.now() }) };
  };
  /** Reviewed registry edit: owner only. */
  catalogUpsert = async (a: Actor, input: catalog.DestinationInput) => {
    ws.requireOwner(a);
    return catalog.upsertDestination(this.db, input, 'reviewed');
  };
  catalogArchive = async (a: Actor, slug: string) => {
    ws.requireOwner(a);
    return catalog.archiveDestination(this.db, slug);
  };
  catalogImport = async (a: Actor, records: catalog.ImportRecord[], source: string, license: string) => {
    ws.requireOwner(a);
    return catalog.importDiscovery(this.db, records, source, license);
  };
  catalogSetHealth = async (a: Actor, slug: string, health: 'healthy' | 'quarantined' | 'broken', reason: string) => {
    ws.requireOwner(a);
    return catalog.setAdapterHealth(this.db, slug, health, reason);
  };
  coverageReport = () => catalog.engineCoverage(this.db, { installedAdapters: new Set(this.adapters.keys()), now: this.now() });

  // ── Accounts ──
  accountStatus = (a: Actor) => ws.listAccounts(this.db, a.workspaceId);
  accountDisconnect = async (a: Actor, id: string) => {
    ws.requireOwner(a);
    return ws.disconnectAccount(this.db, a.workspaceId, id);
  };
  /** Step 1 of an OTP handoff: the code goes to the owner's inbox, not to us. */
  accountConnectStart = async (a: Actor, destination: string, email: string) => {
    ws.requireOwner(a);
    const d = await this.requireDestination(destination);
    if (d.adapter_id !== 'tinylaunch') throw new SubmitFleetError('unsupported_operation', `no connect flow for ${destination}`);
    await tinyLaunchRequestCode(this.fetchImpl, email);
    return { destination: d.slug, next: 'submit the emailed code with account_connect_finish' };
  };
  accountConnectFinish = async (a: Actor, destination: string, email: string, code: string, label?: string) => {
    ws.requireOwner(a);
    if (!this.secretKey) throw new SubmitFleetError('secret_key_missing');
    const d = await this.requireDestination(destination);
    if (d.adapter_id !== 'tinylaunch') throw new SubmitFleetError('unsupported_operation');
    const { secret, expiresAt } = await tinyLaunchVerify(this.fetchImpl, email, code, this.now());
    return ws.connectAccount(this.db, this.secretKey, a.workspaceId, d.id, label ?? email, secret, expiresAt);
  };
  /** For destinations whose account needs no secret (account_requirement 'none') or for tests. */
  accountConnectSecret = async (a: Actor, destination: string, label: string, secret: Record<string, string>, expiresAt: string | null) => {
    ws.requireOwner(a);
    if (!this.secretKey) throw new SubmitFleetError('secret_key_missing');
    const d = await this.requireDestination(destination);
    return ws.connectAccount(this.db, this.secretKey, a.workspaceId, d.id, label, secret, expiresAt);
  };

  // ── Campaigns ──
  campaignPlan = (a: Actor, input: campaigns.PlanInput, campaignId?: string) => campaigns.planCampaign(this.db, a, input, this.planDeps(), campaignId);
  campaignList = (a: Actor) => campaigns.listCampaigns(this.db, a.workspaceId);
  campaignPreview = (a: Actor, id: string) => campaigns.previewCampaign(this.db, a.workspaceId, id);
  approvalRequest = (a: Actor, id: string) => campaigns.requestApproval(this.db, a, id);
  approvalGrant = (a: Actor, id: string, scopeHash?: string) => campaigns.grantApproval(this.db, a, id, scopeHash);
  campaignRun = (a: Actor, id: string) => campaigns.runCampaign(this.db, a, id);
  campaignStatus = (a: Actor, id: string) => campaigns.campaignStatus(this.db, a.workspaceId, id);
  campaignPause = (a: Actor, id: string) => campaigns.pauseCampaign(this.db, a.workspaceId, id);
  campaignCancel = (a: Actor, id: string) => campaigns.cancelCampaign(this.db, a.workspaceId, id);

  /** Global stop: anyone in the workspace may pause; only the owner may resume. */
  pauseAll = (a: Actor) => ws.setPaused(this.db, a.workspaceId, true);
  resumeAll = async (a: Actor) => {
    ws.requireOwner(a);
    return ws.setPaused(this.db, a.workspaceId, false);
  };
  pausedState = (a: Actor) => ws.isPaused(this.db, a.workspaceId);

  // ── Submissions ──
  submissionGet = async (a: Actor, id: string) => {
    const i = await ledger.getIntent(this.db, a.workspaceId, id);
    const { payload: _p, ...rest } = i;
    return { ...rest, events: await ledger.intentEvents(this.db, id) };
  };
  submissionReconcile = async (a: Actor, id: string) => {
    const i = await ledger.getIntent(this.db, a.workspaceId, id);
    const w = this.worker();
    if (i.state === 'uncertain') {
      await w.reconcileUncertain(1000);
      return (await ledger.getIntent(this.db, a.workspaceId, id)).state;
    }
    if (['submitted', 'scheduled', 'under_review', 'published_verified'].includes(i.state)) return w.reconcileOutcome(i);
    throw new SubmitFleetError('invalid_state', `nothing to reconcile in state ${i.state}`);
  };
  submissionUpdate = async (a: Actor, id: string) => this.optionalOp(a, id, 'update');
  submissionWithdraw = async (a: Actor, id: string) => this.optionalOp(a, id, 'withdraw');
  /** Return a needs_human intent to the queue once the owner resolved the blocker. */
  submissionRequeue = async (a: Actor, id: string) => {
    ws.requireOwner(a);
    const i = await ledger.getIntent(this.db, a.workspaceId, id);
    if (i.state !== 'needs_human') throw new SubmitFleetError('invalid_state', `state is ${i.state}`);
    if (i.mode === 'assisted') throw new SubmitFleetError('invalid_state', 'assisted submissions are completed by marking them submitted or skipped');
    return ledger.transition(this.db, i, 'queued', { reason_code: 'owner_requeued' });
  };

  private async optionalOp(a: Actor, id: string, op: 'update' | 'withdraw') {
    ws.requireOwner(a);
    const i = await ledger.getIntent(this.db, a.workspaceId, id);
    const d = await this.requireDestination(i.destination_id);
    const adapter = d.adapter_id ? this.adapters.get(d.adapter_id) : undefined;
    const caps = adapter?.capabilities();
    if (!adapter || !caps?.[op] || !adapter[op]) {
      return { ok: false, reason_code: 'unsupported_operation', external_action_performed: false, detail: `${d.slug} does not support ${op}; nothing was changed remotely` };
    }
    throw new SubmitFleetError('not_implemented', `${op} requires its own approval flow`);
  }

  // ── Reports ──
  reportGet = (a: Actor, id: string) => reports.campaignReport(this.db, a.workspaceId, id);
  reportExport = async (a: Actor, id: string, format: 'markdown' | 'json' | 'csv') => {
    const r = await reports.campaignReport(this.db, a.workspaceId, id);
    if (format === 'markdown') return reports.reportMarkdown(r);
    if (format === 'csv') return reports.reportCsv(r);
    return JSON.stringify(r, null, 2);
  };
  logEffort = async (a: Actor, campaignId: string | null, activity: string, minutes: number, note?: string) => {
    if (!(minutes >= 0)) throw new SubmitFleetError('invalid_request', 'minutes must be >= 0');
    await run(this.db, 'INSERT INTO effort_log (id, workspace_id, campaign_id, activity, minutes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('eff'), a.workspaceId, campaignId, activity, minutes, note, nowIso());
  };
  recordOutcome = async (a: Actor, intentId: string, metric: 'referral_visits' | 'signups' | 'paying_customers', value: number, source: string) => {
    await ledger.getIntent(this.db, a.workspaceId, intentId);
    await run(this.db, 'INSERT INTO outcomes (id, intent_id, observed_at, metric, value, source) VALUES (?, ?, ?, ?, ?, ?)', newId('out'), intentId, nowIso(), metric, value, source);
  };

  // ── Assisted submissions ──
  submissionKit = async (a: Actor, id: string) => {
    const i = await ledger.getIntent(this.db, a.workspaceId, id);
    const product = await products.requireProduct(this.db, a.workspaceId, i.product_id);
    const d = await this.requireDestination(i.destination_id);
    const logo = product.logo_path ? `${this.config.publicOrigin ?? ''}/p/${product.id}/logo` : null;
    return { submission: { id: i.id, state: i.state, mode: i.mode, reason_code: i.reason_code, listing_url: i.listing_url, note: i.note }, ...buildKit(product, d, logo) };
  };

  /** Owner-reported outcome of an assisted submission (or a published/rejected check of any submission). */
  submissionMark = async (a: Actor, id: string, action: 'submitted' | 'live' | 'rejected' | 'skipped', opts: { listing_url?: string | null; note?: string | null } = {}) => {
    ws.requireOwner(a);
    const i = await ledger.getIntent(this.db, a.workspaceId, id);
    const url = opts.listing_url ? safeHttpUrl(opts.listing_url) : null;
    const ts = nowIso(this.now);
    const evidence = { by: 'owner', actor: a.id, note: opts.note ?? null };
    let ok = false;
    if (action === 'submitted') {
      if (i.state !== 'needs_human') throw new SubmitFleetError('invalid_state', `state is ${i.state}`);
      ok = await ledger.transition(this.db, i, 'submitted', { external_action_performed: true, receipt_id: `owner:${ts}`, listing_url: url, submitted_at: ts, reason_code: 'owner_submitted', evidence });
    } else if (action === 'live') {
      if (!url) throw new SubmitFleetError('invalid_request', 'listing_url is required to mark a listing live');
      if (!['submitted', 'scheduled', 'under_review'].includes(i.state)) throw new SubmitFleetError('invalid_state', `state is ${i.state}`);
      ok = await ledger.transition(this.db, i, 'published_verified', { listing_url: url, published_at: ts, reason_code: 'owner_confirmed_live', evidence });
    } else if (action === 'rejected') {
      if (!['submitted', 'scheduled', 'under_review'].includes(i.state)) throw new SubmitFleetError('invalid_state', `state is ${i.state}`);
      ok = await ledger.transition(this.db, i, 'rejected', { reason_code: 'owner_reported_rejected', evidence });
    } else {
      if (i.state !== 'needs_human') throw new SubmitFleetError('invalid_state', `state is ${i.state}`);
      ok = await ledger.transition(this.db, i, 'failed', { reason_code: `skipped${opts.note ? `:${opts.note.slice(0, 80)}` : ''}`, release_dedupe: !i.external_action_performed, evidence });
    }
    if (opts.note) await run(this.db, 'UPDATE intents SET note = ? WHERE id = ?', opts.note.slice(0, 2000), i.id);
    return { ok, state: (await ledger.getIntent(this.db, a.workspaceId, id)).state };
  };

  /** Every submission in a campaign with what the owner needs to work through it. */
  campaignQueue = async (a: Actor, campaignId: string) => {
    const c = await campaigns.getCampaign(this.db, a.workspaceId, campaignId);
    const product = await products.requireProduct(this.db, a.workspaceId, c.product_id);
    const rank: Record<string, number> = { needs_human: 0, uncertain: 1, queued: 2 };
    const rows = await all<Record<string, unknown> & { id: string; destination: string; state: string; domain_rating: number | null }>(
      this.db,
      `SELECT i.id, i.state, i.mode, i.reason_code, i.listing_url, i.submitted_at, i.published_at, i.updated_at,
              d.slug AS destination, d.name, d.channel, d.submission_url, d.domain_rating, d.monthly_traffic, d.link_type, d.logo_url
       FROM intents i JOIN destinations d ON d.id = i.destination_id
       WHERE i.workspace_id = ? AND i.campaign_id = ?
`,
      a.workspaceId,
      campaignId,
    );
    const fits = new Map<string, ReturnType<typeof relevance>>();
    for (const r of rows) {
      const d = await catalog.getDestination(this.db, r.destination);
      if (d) fits.set(r.destination, relevance(product, d));
    }
    return rows
      .map((r) => ({ ...r, fit: fits.get(r.destination)?.fit ?? 'general', fit_reason: fits.get(r.destination)?.reason ?? null }))
      .sort((x, y) => (rank[x.state] ?? 3) - (rank[y.state] ?? 3) || (fits.get(y.destination)?.score ?? 0) - (fits.get(x.destination)?.score ?? 0) || (y.domain_rating ?? -1) - (x.domain_rating ?? -1));
  };

  // ── Product assets and autofill ──
  /** Reads what the product's own page says about it; the owner edits and approves. */
  productExtract = async (url: string) => extractFacts(url, this.config.publicFetch);

  productSetLogo = async (a: Actor, id: string, bytes: Buffer, mime: string) => {
    const t = LOGO_TYPES[mime.split(';')[0]!.trim().toLowerCase()];
    if (!t) throw new SubmitFleetError('invalid_request', 'logo must be PNG, JPEG or WebP');
    if (bytes.length > MAX_LOGO_BYTES) throw new SubmitFleetError('invalid_request', 'logo must be under 1 MB');
    if (!t.magic(bytes)) throw new SubmitFleetError('invalid_request', 'that file is not the image type it claims to be');
    const p = await products.requireProduct(this.db, a.workspaceId, id);
    const rel = `${a.workspaceId}/${p.id}.${t.ext}`;
    await mkdir(join(resolve(this.config.assetsDir), a.workspaceId), { recursive: true });
    await writeFile(join(resolve(this.config.assetsDir), rel), bytes);
    await products.updateProduct(this.db, a.workspaceId, id, { logo_path: rel });
    await run(this.db, 'UPDATE products SET logo_mime = ? WHERE id = ?', mime, id);
    return products.requireProduct(this.db, a.workspaceId, id);
  };

  productLogoFromUrl = async (a: Actor, id: string, url: string) => {
    const r = await fetchPublic(url, this.config.publicFetch, 'image/png,image/jpeg,image/webp');
    const mime = Object.keys(LOGO_TYPES).find((m) => LOGO_TYPES[m]!.magic(r.body));
    if (!mime) throw new SubmitFleetError('invalid_request', 'that URL is not a PNG, JPEG or WebP image');
    return this.productSetLogo(a, id, r.body, mime);
  };

  /** Tries icon candidates in order and keeps the first real PNG, JPEG or WebP. */
  productLogoFromCandidates = async (a: Actor, id: string, urls: string[]) => {
    const errors: string[] = [];
    for (const url of urls.slice(0, 10)) {
      try {
        return await this.productLogoFromUrl(a, id, url);
      } catch (e) {
        errors.push(`${url}: ${e instanceof Error ? e.message : e}`);
      }
    }
    throw new SubmitFleetError('invalid_request', 'none of the icons is a PNG, JPEG or WebP image; upload a logo instead', errors);
  };

  /** Public logo bytes for a product, so a directory form can take a logo URL. */
  productLogo = async (productId: string): Promise<{ bytes: Buffer; mime: string } | null> => {
    const r = await one<{ logo_path: string | null; logo_mime: string | null }>(this.db, 'SELECT logo_path, logo_mime FROM products WHERE id = ?', productId);
    if (!r?.logo_path) return null;
    try {
      return { bytes: await this.readAsset(r.logo_path), mime: r.logo_mime ?? 'image/png' };
    } catch {
      return null;
    }
  };

  // ── API keys for agents and scripts ──
  apiKeyList = (a: Actor) => ws.listApiKeys(this.db, a.workspaceId);
  apiKeyCreate = async (a: Actor, role: ws.Role, label: string) => {
    ws.requireOwner(a);
    return ws.createApiKey(this.db, a.workspaceId, role, label.slice(0, 80) || `${role} key`);
  };
  apiKeyRevoke = async (a: Actor, id: string) => {
    ws.requireOwner(a);
    return ws.revokeApiKey(this.db, a.workspaceId, id);
  };

  /** Catalog entries with how well each fits one product, best fit first. */
  catalogForProduct = async (a: Actor, productId: string, filter: { channels?: string[]; pricing?: string[]; query?: string } = {}) => {
    const product = await products.requireProduct(this.db, a.workspaceId, productId);
    const ds = await catalog.listDestinations(this.db, { limit: 2000, ...filter });
    return ds
      .map((d) => ({ ...d, ...relevance(product, d) }))
      .sort((x, y) => y.score - x.score || (y.domain_rating ?? -1) - (x.domain_rating ?? -1));
  };

  private iconCache = new Map<string, { bytes: Buffer; type: string } | null>();
  /** Destination icons through our own origin: cached, address-checked, and no visitor IPs sent to third parties. */
  destinationIcon = async (slug: string): Promise<{ bytes: Buffer; type: string } | null> => {
    if (this.iconCache.has(slug)) return this.iconCache.get(slug)!;
    const d = await catalog.getDestination(this.db, slug);
    let out: { bytes: Buffer; type: string } | null = null;
    if (d?.logo_url) {
      try {
        const r = await fetchPublic(d.logo_url, this.config.publicFetch, 'image/*');
        const t = r.type.split(';')[0]!.trim();
        if (/^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon)$/.test(t) && r.body.length < 200_000) out = { bytes: r.body, type: t };
      } catch {
        out = null;
      }
    }
    if (this.iconCache.size > 2000) this.iconCache.clear();
    this.iconCache.set(slug, out);
    return out;
  };

  catalogStats = () => catalog.catalogStats(this.db, new Set(this.adapters.keys()));

  /** Loads the bundled curated catalog (CC0) and the reviewed seed records. Idempotent. */
  loadBundledCatalog = async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog');
    const list = JSON.parse(readFileSync(join(root, 'submitlist.json'), 'utf8')) as { destinations: catalog.SubmitlistRecord[]; source?: string };
    const imported = await catalog.importSubmitlist(this.db, list.destinations, list.source ?? 'https://github.com/alvinunreal/awesome-submitlist');
    const seed = JSON.parse(readFileSync(join(root, 'seed.json'), 'utf8')) as { destinations: catalog.DestinationInput[] };
    let seeded = 0;
    for (const d of seed.destinations) {
      const existing = await catalog.getDestination(this.db, d.slug);
      // Reviewed seed facts apply once; later reviewed edits are never overwritten by a boot.
      if (existing?.adapter_id) continue;
      await catalog.upsertDestination(this.db, d, 'reviewed');
      seeded++;
    }
    return { ...imported, seeded };
  };

  humanQueue = async (a: Actor) =>
    all(this.db, "SELECT i.id, i.campaign_id, d.slug AS destination, i.state, i.reason_code, i.updated_at FROM intents i JOIN destinations d ON d.id = i.destination_id WHERE i.workspace_id = ? AND i.state IN ('needs_human', 'uncertain') ORDER BY i.updated_at", a.workspaceId);

  private async requireDestination(idOrSlug: string) {
    const d = await catalog.getDestination(this.db, idOrSlug);
    if (!d) throw new SubmitFleetError('not_found', `destination ${idOrSlug}`);
    return d;
  }

  /** Non-mutating health check of this install. */
  doctor = async () => {
    const checks: { check: string; ok: boolean; detail?: string }[] = [];
    try {
      await all(this.db, 'SELECT 1');
      checks.push({ check: 'database', ok: true, detail: this.config.dbUrl.replace(/\?.*$/, '') });
    } catch (e) {
      checks.push({ check: 'database', ok: false, detail: String(e) });
    }
    checks.push({ check: 'secret_key', ok: !!this.secretKey, detail: this.secretKey ? 'loaded' : 'SUBMITFLEET_SECRET_KEY not set: accounts cannot be connected' });
    checks.push({ check: 'adapters', ok: this.adapters.size > 0, detail: [...this.adapters.values()].map((a) => `${a.id}@${a.version}`).join(', ') });
    const cov = await this.coverageReport();
    checks.push({ check: 'release_coverage', ok: cov.status === 'release_ready', detail: `${cov.release_qualifying}/${cov.release_minimum} qualifying (${cov.status})` });
    return checks;
  };
}

function safeHttpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SubmitFleetError('invalid_request', 'listing_url must be a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SubmitFleetError('invalid_request', 'listing_url must be http(s)');
  return u.toString();
}
