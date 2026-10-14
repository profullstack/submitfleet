// TinyLaunch adapter, built against the official agent guide (https://www.tinylaunch.com/llms.txt,
// read 2026-10-14). Free route only: `premium` and `submission_service_tier` are never
// sent, and any response that carries a payment link or a premium/unpaid flag stops the
// job for a human instead of being reported as success.
//
// STATUS: contract-tested against recorded shapes only. No live submission has been
// made, so the catalog record must not be marked live-tested until one is.

import type { Destination } from '../catalog.js';
import type { Product } from '../products.js';
import { SubmitFleetError } from '../util.js';
import type { Adapter, ExecContext, ExecResult, PrepareContext, ReconcileResult, ValidationIssue } from './types.js';

export const TINYLAUNCH_BASE = 'https://www.tinylaunch.com/api/v1';
const MAX_LOGO_BYTES = 209_715;
const LOGO_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_DATE_ATTEMPTS = 3;

interface TinyLaunchPayload {
  startup: { name: string; tagline: string; description: string; url: string; category_id: number; logo: { filename: string; content_base64: string } };
  earliest_date: string | null;
  latest_date: string | null;
  _estimated_cost_cents: number;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Plain text paragraphs to TinyLaunch's allowed HTML subset (<p> only, escaped). */
export function toDescriptionHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function fields(product: Product): Record<string, unknown> {
  return product.destination_fields.tinylaunch ?? {};
}

async function api(ctx: ExecContext, method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await ctx.fetch(`${TINYLAUNCH_BASE}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctx.signal,
    redirect: 'error',
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body; status alone decides
  }
  return { status: res.status, json };
}

function paidSignal(j: Record<string, unknown>): string | null {
  if (j.payment_url) return 'payment_url_returned';
  if (j.premium === true) return 'premium_flag_set';
  if (j.paid === false) return 'unpaid_launch';
  if (j.submission_service_tier) return 'paid_tier_set';
  return null;
}

export function tinyLaunchAdapter(): Adapter {
  return {
    id: 'tinylaunch',
    version: '0.1.0',
    destinationSlug: 'tinylaunch',
    method: 'api',

    capabilities() {
      return {
        update: false,
        withdraw: false,
        reconcile: 'limited',
        reconcileLimitation:
          'The documented API lists your startups but not your launches, so a scheduled launch is confirmed from the POST /launches receipt and the public /launch/{id} page; moderator review status is not exposed.',
      };
    },

    validate(product: Product, _d: Destination): ValidationIssue[] {
      const issues: ValidationIssue[] = [];
      const need = (ok: boolean, field: string, code: string, message: string) => ok || issues.push({ field, code, message });
      need(!!product.name && product.name.length <= 30, 'name', 'missing_or_too_long', 'name is required, 1-30 characters');
      need(!!product.tagline && product.tagline.length <= 60, 'tagline', 'missing_or_too_long', 'tagline is required, 1-60 characters');
      need(!!product.description && product.description.length <= 9000, 'description', 'missing_or_too_long', 'description is required');
      need(/^https?:\/\//.test(product.url), 'url', 'invalid', 'url must be http(s)');
      const cat = Number(fields(product).category_id);
      need(Number.isInteger(cat) && cat > 0, 'destination_fields.tinylaunch.category_id', 'missing_fact', 'choose a TinyLaunch category id; it is never guessed');
      need(!!product.logo_path && LOGO_EXT.test(product.logo_path), 'logo_path', 'missing_or_bad_format', 'logo must be PNG, JPG or WebP');
      return issues;
    },

    async prepare(ctx: PrepareContext) {
      const p = ctx.product;
      const issues = this.validate(p, ctx.destination);
      if (issues.length) throw new SubmitFleetError('validation_failed', issues.map((i) => i.field).join(', '), issues);
      const logo = await ctx.readAsset(p.logo_path!);
      if (logo.length > MAX_LOGO_BYTES) throw new SubmitFleetError('logo_too_large', `${logo.length} bytes > ${MAX_LOGO_BYTES}`);
      const payload: TinyLaunchPayload = {
        startup: {
          name: p.name!,
          tagline: p.tagline!,
          description: toDescriptionHtml(p.description!),
          url: p.url,
          category_id: Number(fields(p).category_id),
          logo: { filename: p.logo_path!.split('/').pop()!, content_base64: logo.toString('base64') },
        },
        earliest_date: ctx.earliestDate ?? null,
        latest_date: ctx.latestDate ?? null,
        _estimated_cost_cents: 0,
      };
      return payload as unknown as Record<string, unknown>;
    },

    async preflight(ctx) {
      const creds = await ctx.credentials();
      if (!creds.access_token) return { ok: false, reasonCode: 'session_missing' };
      const exp = Number(creds.expires_at_ms ?? 0);
      if (exp && exp - ctx.now() < 5 * 60_000) return { ok: false, reasonCode: 'session_expired' };
      return { ok: true };
    },

    async execute(ctx): Promise<ExecResult> {
      const payload = ctx.payload as unknown as TinyLaunchPayload;
      const { access_token: token } = await ctx.credentials();
      if (!token) return { kind: 'needs_human', reasonCode: 'session_missing', externalActionPerformed: false };

      const maker = await api(ctx, 'GET', '/maker', token);
      if (maker.status === 401) return { kind: 'needs_human', reasonCode: 'session_expired', externalActionPerformed: !!ctx.remoteRefs.startup_id };
      // Creating a maker profile is account setup, a separately authorised operation.
      if (maker.status === 404) return { kind: 'needs_human', reasonCode: 'maker_profile_missing', externalActionPerformed: false };
      if (maker.status !== 200) return { kind: 'failed', reasonCode: `maker_http_${maker.status}`, externalActionPerformed: !!ctx.remoteRefs.startup_id };

      let startupId = ctx.remoteRefs.startup_id as number | undefined;
      if (!startupId) {
        const s = await api(ctx, 'POST', '/startups', token, payload.startup);
        if (s.status === 201 && typeof s.json.id === 'number') {
          startupId = s.json.id;
          await ctx.recordRemote({ startup_id: startupId, startup_slug: s.json.slug ?? null });
        } else if (s.status >= 500) {
          return { kind: 'uncertain', reasonCode: `startup_http_${s.status}` };
        } else {
          return { kind: 'failed', reasonCode: String(s.json.error ?? `startup_http_${s.status}`), externalActionPerformed: false, evidence: { status: s.status, error: s.json.error } };
        }
      }

      const dates = await bookableFreeDates(ctx, payload.earliest_date, payload.latest_date);
      if (!dates.length) return { kind: 'needs_human', reasonCode: 'no_free_date_in_approved_window', externalActionPerformed: true };

      for (const date of dates.slice(0, MAX_DATE_ATTEMPTS)) {
        // Free route: exactly startup_id + date. Never premium, never a submission tier.
        const l = await api(ctx, 'POST', '/launches', token, { startup_id: startupId, date });
        const paid = paidSignal(l.json);
        if (paid) {
          await ctx.recordRemote({ launch_id: l.json.id ?? null, unexpected_payment: paid });
          return { kind: 'needs_human', reasonCode: `unexpected_payment:${paid}`, externalActionPerformed: true, evidence: { launch_id: l.json.id ?? null } };
        }
        if (l.status === 201 && l.json.id != null) {
          const launchId = String(l.json.id);
          await ctx.recordRemote({ launch_id: launchId, launch_date: date });
          return {
            kind: 'scheduled',
            remoteId: launchId,
            receiptId: `tinylaunch:launch:${launchId}`,
            listingUrl: `https://www.tinylaunch.com/launch/${launchId}`,
            costCents: 0,
            evidence: { startup_id: startupId, launch_id: launchId, date, premium: l.json.premium ?? null },
          };
        }
        if (l.status === 409 && l.json.error === 'date_full') continue;
        if (l.status === 409 && l.json.error === 'duplicate_launch') return { kind: 'needs_human', reasonCode: 'duplicate_launch_reported', externalActionPerformed: true };
        if (l.status >= 500) return { kind: 'uncertain', reasonCode: `launch_http_${l.status}` };
        return { kind: 'needs_human', reasonCode: String(l.json.error ?? `launch_http_${l.status}`), externalActionPerformed: true };
      }
      return { kind: 'needs_human', reasonCode: 'free_dates_full', externalActionPerformed: true };
    },

    async reconcile(ctx): Promise<ReconcileResult> {
      const launchId = ctx.remoteRefs.launch_id;
      if (launchId) {
        const res = await ctx.fetch(`https://www.tinylaunch.com/launch/${launchId}`, { method: 'GET', signal: ctx.signal, redirect: 'follow' });
        if (res.status === 200) return { status: 'found', state: 'scheduled', remoteId: String(launchId), listingUrl: `https://www.tinylaunch.com/launch/${launchId}`, evidence: { http: 200 } };
        return { status: 'unknown', reasonCode: `launch_page_http_${res.status}` };
      }
      const { access_token: token } = await ctx.credentials();
      if (!token) return { status: 'unknown', reasonCode: 'session_missing' };
      const list = await api(ctx, 'GET', '/startups', token);
      if (list.status !== 200) return { status: 'unknown', reasonCode: `startups_http_${list.status}` };
      const items = (Array.isArray(list.json) ? list.json : (list.json.startups as unknown[]) ?? []) as Record<string, unknown>[];
      const want = (ctx.payload as unknown as TinyLaunchPayload).startup.url.replace(/\/+$/, '');
      const match = items.find((s) => String(s.url ?? '').replace(/\/+$/, '') === want);
      if (match) {
        await ctx.recordRemote({ startup_id: match.id });
        // The startup exists but launches are not listable: a launch may or may not exist.
        return { status: 'unknown', reasonCode: 'startup_found_launch_unknown', evidence: { startup_id: match.id } };
      }
      // No startup means no launch could have been created for it.
      return { status: 'absent', evidence: { startups_checked: items.length } };
    },
  };
}

async function bookableFreeDates(ctx: ExecContext, earliest: string | null, latest: string | null): Promise<string[]> {
  const out: string[] = [];
  let offset: number | null = 0;
  for (let page = 0; page < 5 && offset != null; page++) {
    const r = await api(ctx, 'GET', `/launch-dates?offset=${offset}`, null);
    if (r.status !== 200) break;
    const windows = (r.json.windows as { date: string; bookable_free: boolean }[]) ?? [];
    for (const w of windows) {
      if (!w.bookable_free) continue;
      if (earliest && w.date < earliest) continue;
      if (latest && w.date > latest) return out;
      out.push(w.date);
    }
    offset = typeof r.json.next_offset === 'number' ? r.json.next_offset : null;
    if (out.length >= MAX_DATE_ATTEMPTS) break;
  }
  return out;
}

/** OTP login handoff. The code comes from the owner's inbox; it is never stored. */
export async function tinyLaunchRequestCode(f: typeof fetch, email: string): Promise<void> {
  const r = await f(`${TINYLAUNCH_BASE}/auth/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  if (!r.ok) throw new SubmitFleetError('otp_request_failed', `HTTP ${r.status}`);
}

export async function tinyLaunchVerify(f: typeof fetch, email: string, code: string, now = Date.now()): Promise<{ secret: Record<string, string>; expiresAt: string }> {
  const r = await f(`${TINYLAUNCH_BASE}/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
  const j = (await r.json().catch(() => ({}))) as Record<string, string>;
  if (!r.ok || !j.access_token) throw new SubmitFleetError('otp_verify_failed', j.error ?? `HTTP ${r.status}`);
  // The guide says tokens last about an hour and documents no refresh call.
  const exp = now + 55 * 60_000;
  return { secret: { access_token: j.access_token, refresh_token: j.refresh_token ?? '', expires_at_ms: String(exp) }, expiresAt: new Date(exp).toISOString() };
}
