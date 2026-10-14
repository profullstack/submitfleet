import { getBudget } from './budgets.js';
import { getCampaign, previewCampaign } from './campaigns.js';
import { all, type Db } from './db.js';
import { listIntents } from './ledger.js';
import { requireProduct } from './products.js';
import { parseJson } from './util.js';

export interface CampaignReport {
  campaign_id: string;
  product: { id: string; url: string; name: string | null };
  status: string;
  generated_at: string;
  original_targets: number;
  executable_at_plan: number;
  min_executable: number;
  exclusions: { destination: string; blockers: string[] }[];
  outcomes: Record<string, number>;
  /** Technical execution rate keeps runtime challenges and failures in the denominator. */
  execution: { attempted_denominator: number; evidenced_receipts: number; rate: number | null };
  submissions: {
    id: string;
    destination: string;
    state: string;
    reason_code: string | null;
    external_action_performed: boolean;
    receipt_id: string | null;
    remote_id: string | null;
    listing_url: string | null;
    submitted_at: string | null;
    published_at: string | null;
    removed_at: string | null;
    cost_cents: number;
  }[];
  unresolved: string[];
  human_effort_minutes: number | null;
  costs: { operating_spent_cents: number; operating_limit_cents: number; listing_spend_cents: 0 };
  analytics: { referral_visits: number | null; signups: number | null; paying_customers: number | null; note: string };
  limitations: string[];
}

const UNRESOLVED = new Set(['queued', 'executing', 'uncertain', 'needs_human']);

export async function campaignReport(db: Db, workspaceId: string, campaignId: string): Promise<CampaignReport> {
  const c = await getCampaign(db, workspaceId, campaignId);
  const product = await requireProduct(db, workspaceId, c.product_id);
  const preview = await previewCampaign(db, workspaceId, campaignId);
  const intents = await listIntents(db, workspaceId, campaignId);
  const slugs = new Map((await all<{ id: string; slug: string }>(db, 'SELECT id, slug FROM destinations')).map((r) => [r.id, r.slug]));
  const outcomes: Record<string, number> = {};
  for (const i of intents) outcomes[i.state] = (outcomes[i.state] ?? 0) + 1;
  const budget = await getBudget(db, campaignId);
  const effort = await all<{ m: number | null }>(db, 'SELECT SUM(minutes) AS m FROM effort_log WHERE campaign_id = ?', campaignId);
  const metrics = await all<{ metric: string; v: number | null }>(
    db,
    'SELECT o.metric, SUM(o.value) AS v FROM outcomes o JOIN intents i ON i.id = o.intent_id WHERE i.campaign_id = ? GROUP BY o.metric',
    campaignId,
  );
  const metric = (k: string) => {
    const m = metrics.find((x) => x.metric === k);
    return m && m.v != null ? Number(m.v) : null;
  };
  const evidenced = intents.filter((i) => i.receipt_id).length;
  const denominator = intents.filter((i) => i.state !== 'canceled' || i.external_action_performed).length;
  const limitations: string[] = [];
  if (!metrics.length) limitations.push('No analytics connected: referral outcomes are unknown, not zero.');
  if (effort[0]?.m == null) limitations.push('No human effort was logged; labour totals are unknown.');
  if (intents.some((i) => i.state === 'scheduled' || i.state === 'submitted')) {
    limitations.push('Submitted and scheduled listings are not published until verified live.');
  }
  return {
    campaign_id: c.id,
    product: { id: product.id, url: product.url, name: product.name },
    status: c.status,
    generated_at: new Date().toISOString(),
    original_targets: preview.executable.length + preview.blocked.length,
    executable_at_plan: c.executable_count,
    min_executable: c.min_executable,
    exclusions: preview.blocked,
    outcomes,
    execution: { attempted_denominator: denominator, evidenced_receipts: evidenced, rate: denominator ? evidenced / denominator : null },
    submissions: intents.map((i) => ({
      id: i.id,
      destination: slugs.get(i.destination_id) ?? i.destination_id,
      state: i.state,
      reason_code: i.reason_code,
      external_action_performed: i.external_action_performed,
      receipt_id: i.receipt_id,
      remote_id: i.remote_id,
      listing_url: i.listing_url,
      submitted_at: i.submitted_at,
      published_at: i.published_at,
      removed_at: i.removed_at,
      cost_cents: i.cost_cents,
    })),
    unresolved: intents.filter((i) => UNRESOLVED.has(i.state)).map((i) => i.id),
    human_effort_minutes: effort[0]?.m == null ? null : Number(effort[0].m),
    costs: { operating_spent_cents: Number(budget?.spent_cents ?? 0), operating_limit_cents: Number(budget?.limit_cents ?? c.spend_limit_cents), listing_spend_cents: 0 },
    analytics: {
      referral_visits: metric('referral_visits'),
      signups: metric('signups'),
      paying_customers: metric('paying_customers'),
      note: 'Attributed outcomes are not automatically incremental.',
    },
    limitations,
  };
}

const show = (v: unknown) => (v === null || v === undefined ? 'unknown' : String(v));
const cents = (n: number) => `$${(n / 100).toFixed(2)}`;

export function reportMarkdown(r: CampaignReport): string {
  const lines = [
    `# SubmitFleet campaign report`,
    '',
    `- Product: ${r.product.name ?? r.product.url} (${r.product.url})`,
    `- Campaign: \`${r.campaign_id}\`, status **${r.status}**`,
    `- Generated: ${r.generated_at}`,
    `- Target set at plan: ${r.original_targets} considered, ${r.executable_at_plan} executable, ${r.min_executable} required`,
    `- Technical execution: ${r.execution.evidenced_receipts} evidenced receipts of ${r.execution.attempted_denominator} (${r.execution.rate == null ? 'n/a' : `${Math.round(r.execution.rate * 100)}%`})`,
    `- Human effort: ${r.human_effort_minutes == null ? 'unknown (not logged)' : `${r.human_effort_minutes} min`}`,
    `- Operating cost: ${cents(r.costs.operating_spent_cents)} of ${cents(r.costs.operating_limit_cents)} limit; listing fees ${cents(0)}`,
    '',
    '## Outcomes',
    '',
    ...Object.entries(r.outcomes).map(([k, v]) => `- ${k}: ${v}`),
    ...(Object.keys(r.outcomes).length ? [] : ['- none yet']),
    '',
    '## Submissions',
    '',
    '| Destination | State | Receipt | Listing | Submitted | Published |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.submissions.map((s) => `| ${s.destination} | ${s.state}${s.reason_code ? ` (${s.reason_code})` : ''} | ${show(s.receipt_id)} | ${s.listing_url ?? 'unknown'} | ${show(s.submitted_at)} | ${show(s.published_at)} |`),
    '',
    '## Analytics',
    '',
    `- Referral visits: ${show(r.analytics.referral_visits)}`,
    `- Signups: ${show(r.analytics.signups)}`,
    `- Paying customers: ${show(r.analytics.paying_customers)}`,
    `- ${r.analytics.note}`,
    '',
    '## Exclusions',
    '',
    ...r.exclusions.slice(0, 200).map((e) => `- ${e.destination}: ${e.blockers.join(', ')}`),
    ...(r.exclusions.length > 200 ? [`- ...and ${r.exclusions.length - 200} more`] : []),
    '',
    '## Limitations',
    '',
    ...r.limitations.map((l) => `- ${l}`),
    ...(r.limitations.length ? [] : ['- none recorded']),
    '',
  ];
  return lines.join('\n');
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function reportCsv(r: CampaignReport): string {
  const cols = ['id', 'destination', 'state', 'reason_code', 'external_action_performed', 'receipt_id', 'remote_id', 'listing_url', 'submitted_at', 'published_at', 'removed_at', 'cost_cents'] as const;
  return [cols.join(','), ...r.submissions.map((s) => cols.map((c) => csvCell(s[c])).join(','))].join('\n') + '\n';
}

export function parseBlockers(json: string): string[] {
  return parseJson(json, []);
}
