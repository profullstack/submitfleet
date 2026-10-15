import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SubmitFleet } from './service.js';
import { SubmitFleetError } from './util.js';
import type { Actor } from './workspaces.js';

export const MCP_SERVER_VERSION = '0.1.0';

type Json = unknown;

function ok(value: Json) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true }, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

function fail(e: unknown) {
  const code = e instanceof SubmitFleetError ? e.code : 'internal_error';
  const message = e instanceof Error ? e.message : String(e);
  const detail = e instanceof SubmitFleetError ? e.detail : undefined;
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message, detail, external_action_performed: false }) }] };
}

const wrap =
  <A>(fn: (args: A) => Promise<Json>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

const page = { limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() };
const productFields = {
  name: z.string().max(200).nullable().optional(),
  tagline: z.string().max(200).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  categories: z.array(z.string().max(100)).max(50).optional(),
  contact_email: z.string().email().nullable().optional(),
  logo_path: z.string().max(500).nullable().optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  destination_fields: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
};

/**
 * Builds the MCP server for one authenticated actor. There is deliberately no tool
 * that grants approval: an agent can request approval, never sign it.
 */
export function buildMcpServer(fleet: SubmitFleet, actor: Actor): McpServer {
  const s = new McpServer({ name: 'submitfleet', version: MCP_SERVER_VERSION });
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const read = { readOnlyHint: true, openWorldHint: false };

  s.registerTool('submitfleet_product_create', { description: 'Create a product profile from its canonical URL and facts you can source. Facts must be approved by the owner before any campaign can use them.', inputSchema: { url: z.string().url(), ...productFields }, annotations: write }, wrap((a) => fleet.productCreate(actor, a as never)));
  s.registerTool('submitfleet_product_get', { description: 'Get one product.', inputSchema: { id: z.string() }, annotations: read }, wrap((a) => fleet.productGet(actor, a.id)));
  s.registerTool('submitfleet_product_list', { description: 'List products in this workspace.', inputSchema: page, annotations: read }, wrap((a) => fleet.productList(actor, a.limit, a.offset)));
  s.registerTool('submitfleet_product_update', { description: 'Update product facts. Any change clears owner approval of the facts and invalidates affected campaign approvals.', inputSchema: { id: z.string(), ...productFields }, annotations: write }, wrap(({ id, ...patch }) => fleet.productUpdate(actor, id, patch as never)));
  s.registerTool('submitfleet_product_delete', { description: 'Delete local product data (owner only). Never deletes remote listings.', inputSchema: { id: z.string() }, annotations: { ...write, destructiveHint: true } }, wrap(async (a) => { await fleet.productDelete(actor, a.id); return { deleted: a.id, remote_listings_deleted: false }; }));

  s.registerTool('submitfleet_catalog_search', { description: 'Search the destination catalog.', inputSchema: { query: z.string().max(200).optional(), ...page }, annotations: read }, wrap((a) => fleet.catalogSearch(a.query, a.limit, a.offset)));
  s.registerTool('submitfleet_catalog_get', { description: 'Get one destination with its qualification stages and blockers.', inputSchema: { slug: z.string() }, annotations: read }, wrap((a) => fleet.catalogGet(a.slug)));
  s.registerTool(
    'submitfleet_catalog_import',
    { description: 'Import discovery records (owner only). Imported records never enable execution.', inputSchema: { source: z.string(), license: z.string(), records: z.array(z.object({ name: z.string(), url: z.string().url(), kind: z.string().optional(), categories: z.array(z.string()).optional(), labeled_free: z.boolean().optional() })).max(5000) }, annotations: write },
    wrap((a) => fleet.catalogImport(actor, a.records, a.source, a.license)),
  );
  s.registerTool('submitfleet_catalog_refresh', { description: 'Report which catalog evidence is stale and needs a reviewed refresh. Non-mutating.', inputSchema: {}, annotations: read }, wrap(async () => {
    const cov = await fleet.coverageReport();
    return { stale: { fee: cov.blocker_counts.fee_evidence_stale ?? 0, permission: cov.blocker_counts.permission_evidence_stale ?? 0 }, note: 'Refreshing evidence is a reviewed registry edit; this tool never marks anything verified.' };
  }));
  s.registerTool('submitfleet_coverage_report', { description: 'Engine coverage by stage. The 100-destination release gate counts independent listing groups only.', inputSchema: {}, annotations: read }, wrap(() => fleet.coverageReport()));

  const planInput = {
    product_id: z.string(),
    min_executable_destinations: z.number().int().min(1).optional(),
    spend_limit_cents: z.number().int().min(0).optional(),
    earliest_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    latest_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    release_scope: z.string().max(100).optional(),
    destinations: z.array(z.string()).max(1000).optional(),
    mode: z.enum(['all', 'auto_only']).optional(),
    channels: z.array(z.string()).max(20).optional(),
    include_unknown_pricing: z.boolean().optional(),
    campaign_id: z.string().optional(),
  };
  s.registerTool(
    'submitfleet_campaign_plan',
    { description: 'Plan (or re-plan) a free-only campaign. Each target is auto (a qualified adapter submits it) or assisted (the owner submits it from a prepared copy kit). mode auto_only is the strict unattended mode: below min_executable_destinations (default 100 there) the result is coverage_insufficient with the real count and blockers, and nothing can run.', inputSchema: planInput, annotations: write },
    wrap(async (a) => {
      const plan = await fleet.campaignPlan(
        actor,
        { productId: a.product_id, minExecutableDestinations: a.min_executable_destinations, spendLimitCents: a.spend_limit_cents, earliestDate: a.earliest_date, latestDate: a.latest_date, releaseScope: a.release_scope, destinations: a.destinations, mode: a.mode, channels: a.channels, includeUnknownPricing: a.include_unknown_pricing },
        a.campaign_id,
      );
      return { campaign: plan.campaign, counts: plan.counts, blocked: plan.targets.filter((t) => !t.executable).slice(0, 200), executable: plan.targets.filter((t) => t.executable).map((t) => t.destination) };
    }),
  );
  s.registerTool('submitfleet_campaign_preview', { description: 'Exact payloads, accounts and blockers the owner would approve, plus the scope hash.', inputSchema: { campaign_id: z.string() }, annotations: read }, wrap((a) => fleet.campaignPreview(actor, a.campaign_id)));
  s.registerTool('submitfleet_approval_request', { description: 'Ask the owner to approve this exact campaign scope. Approval happens in the dashboard or CLI, never through MCP.', inputSchema: { campaign_id: z.string() }, annotations: write }, wrap(async (a) => ({ ...(await fleet.approvalRequest(actor, a.campaign_id)), next: 'owner approves at /app or with `submitfleet campaign approve`' })));
  s.registerTool('submitfleet_campaign_run', { description: 'Queue an owner-approved campaign for the workers (or resume a paused one). Refuses if anything material changed since approval.', inputSchema: { campaign_id: z.string() }, annotations: { ...write, openWorldHint: true } }, wrap((a) => fleet.campaignRun(actor, a.campaign_id)));
  s.registerTool('submitfleet_campaign_status', { description: 'Campaign state and intent counts by state.', inputSchema: { campaign_id: z.string() }, annotations: read }, wrap((a) => fleet.campaignStatus(actor, a.campaign_id)));
  s.registerTool('submitfleet_campaign_pause', { description: 'Pause a running campaign. Use pause_all to stop every outbound write.', inputSchema: { campaign_id: z.string() }, annotations: write }, wrap(async (a) => { await fleet.campaignPause(actor, a.campaign_id); return { paused: a.campaign_id }; }));
  s.registerTool('submitfleet_campaign_cancel', { description: 'Cancel unsent work. Does not delete remote listings that already exist.', inputSchema: { campaign_id: z.string() }, annotations: { ...write, destructiveHint: true } }, wrap(async (a) => ({ ...(await fleet.campaignCancel(actor, a.campaign_id)), remote_listings_deleted: false })));
  s.registerTool('submitfleet_pause_all', { description: 'Immediately stop all new outbound writes for the workspace. Only the owner can resume.', inputSchema: {}, annotations: write }, wrap(async () => { await fleet.pauseAll(actor); return { paused: true }; }));

  s.registerTool('submitfleet_account_status', { description: 'Connected destination accounts (never secrets).', inputSchema: {}, annotations: read }, wrap(() => fleet.accountStatus(actor)));
  s.registerTool('submitfleet_account_connect', { description: 'Account connection is an owner handoff: it returns the CLI/dashboard step, because codes and passwords must never pass through model context.', inputSchema: { destination: z.string() }, annotations: read }, wrap(async (a) => ({ handoff: true, run: `submitfleet accounts connect ${a.destination} --email <owner email>`, or: '/app#accounts' })));
  s.registerTool('submitfleet_account_disconnect', { description: 'Disconnect an account (owner only); queued work for it stops.', inputSchema: { account_id: z.string() }, annotations: write }, wrap(async (a) => { await fleet.accountDisconnect(actor, a.account_id); return { disconnected: a.account_id }; }));

  s.registerTool('submitfleet_submission_get', { description: 'One submission with its immutable event history.', inputSchema: { id: z.string() }, annotations: read }, wrap((a) => fleet.submissionGet(actor, a.id)));
  s.registerTool('submitfleet_submission_reconcile', { description: 'Reconcile an uncertain submission, or check a submitted one for publication, using permitted reads only.', inputSchema: { id: z.string() }, annotations: { ...read, openWorldHint: true } }, wrap(async (a) => ({ state: await fleet.submissionReconcile(actor, a.id) })));
  s.registerTool('submitfleet_submission_update', { description: 'Update a remote listing if the destination supports it; otherwise unsupported_operation.', inputSchema: { id: z.string() }, annotations: write }, wrap((a) => fleet.submissionUpdate(actor, a.id)));
  s.registerTool('submitfleet_submission_withdraw', { description: 'Withdraw a remote listing if the destination supports it; otherwise unsupported_operation.', inputSchema: { id: z.string() }, annotations: { ...write, destructiveHint: true } }, wrap((a) => fleet.submissionWithdraw(actor, a.id)));
  s.registerTool('submitfleet_campaign_queue', { description: 'Every submission in a campaign: destination, mode (auto or assisted), state and listing URL.', inputSchema: { campaign_id: z.string() }, annotations: read }, wrap((a) => fleet.campaignQueue(actor, a.campaign_id)));
  s.registerTool('submitfleet_submission_kit', { description: 'The prepared copy kit for one submission: submit URL, eligibility, pricing note and every field value from the approved product facts.', inputSchema: { id: z.string() }, annotations: read }, wrap((a) => fleet.submissionKit(actor, a.id)));
  s.registerTool('submitfleet_catalog_stats', { description: 'Catalog size by channel, how many are free to list, and how many submit automatically.', inputSchema: {}, annotations: read }, wrap(() => fleet.catalogStats()));
  s.registerTool('submitfleet_human_queue', { description: 'Jobs waiting for a person: challenges, payments, expired sessions, unresolved uncertainty.', inputSchema: {}, annotations: read }, wrap(() => fleet.humanQueue(actor)));

  s.registerTool('submitfleet_report_get', { description: 'Campaign report: original targets, exclusions, receipts, listing URLs, unresolved jobs, costs. Unknowns stay null.', inputSchema: { campaign_id: z.string() }, annotations: read }, wrap((a) => fleet.reportGet(actor, a.campaign_id)));
  s.registerTool('submitfleet_report_export', { description: 'Export a campaign report as markdown, json or csv.', inputSchema: { campaign_id: z.string(), format: z.enum(['markdown', 'json', 'csv']) }, annotations: read }, wrap((a) => fleet.reportExport(actor, a.campaign_id, a.format)));

  addListCacheFields(s);
  return s;
}

/**
 * Newer MCP clients validate tools/list strictly and reject a list without its cache
 * metadata. Extra fields are ignored by older clients, so always send them.
 */
function addListCacheFields(s: McpServer): void {
  const handlers = (s.server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<Record<string, unknown>>> })._requestHandlers;
  const original = handlers?.get('tools/list');
  if (!original) return;
  handlers.set('tools/list', async (req, extra) => ({ ...(await original(req, extra)), resultType: 'complete', ttlMs: 300_000, cacheScope: 'private' }));
}
