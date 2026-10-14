import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { builtinAdapters } from './adapters/index.js';
import type { Adapter } from './adapters/types.js';
import { tinyLaunchRequestCode, tinyLaunchVerify } from './adapters/tinylaunch.js';
import * as campaigns from './campaigns.js';
import * as catalog from './catalog.js';
import { all, openDb, run, type Db } from './db.js';
import * as ledger from './ledger.js';
import * as products from './products.js';
import * as reports from './reports.js';
import { loadSecretKey, newId, nowIso, SubmitFleetError } from './util.js';
import { Worker } from './worker.js';
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
}

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

  close(): void {
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
  catalogSearch = (query?: string, limit?: number, offset?: number) => catalog.listDestinations(this.db, { query, limit, offset });
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
