#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DestinationInput, ImportRecord } from './catalog.js';
import { loadConfig } from './config.js';
import { buildApp } from './http.js';
import { buildMcpServer } from './mcp.js';
import { SubmitFleet } from './service.js';
import { runTui } from './tui.js';
import { resendMailer } from './mail.js';
import { accessToken, DEFAULT_URL, login, loginWithKey, logout, mcpStdioProxy, readAuth, remote } from './remote.js';
import { SubmitFleetError } from './util.js';
import { createApiKey, ensureDefaultWorkspace, type Actor, type Role } from './workspaces.js';

export const EXIT = { ok: 0, error: 1, usage: 2, gate: 3, needs_human: 4 } as const;

const HELP = `submitfleet - coordinated launch and directory submissions with proof of what went live

Usage: submitfleet <command> [options]

Account (hosted at submitfleet.com, or --url for your own server)
  login [--url URL] [--no-browser]       sign in through your browser (OAuth 2.1 + PKCE); later commands use your account
  login --key KEY | --key -              sign in with an API key from Settings (- reads it from stdin)
                                         or set SUBMITFLEET_API_KEY (and SUBMITFLEET_URL) in the environment
  logout | whoami
  --local                                ignore the signed-in account and use the local database

Setup (self-hosted)
  init                                   create the local workspace, secret key and an owner API key
  doctor                                 non-mutating health check
  keys create --role owner|agent [--label L]

Catalog
  catalog seed                           load the reviewed seed records
  catalog search [QUERY] [--json]
  catalog get SLUG
  catalog import FILE.json --source S --license L
  catalog health SLUG --set healthy|quarantined|broken --reason TEXT
  coverage report [--min-supported 100] [--json]   exit 3 when below the minimum

Products
  products add URL [--name N] [--tagline T] [--description D] [--category C]... [--logo PATH] [--field dest.key=value]...
  products list | products get ID
  products approve ID                    owner approves the product facts (interactive)

Accounts
  accounts connect DESTINATION --email EMAIL   emailed-code handoff; the code is typed here, never stored
  accounts list | accounts disconnect ID

Campaigns
  campaign plan --product ID [--free-only] [--auto-only] [--min-executable-destinations N] [--spend-limit-cents 0]
                [--channel directory|product-launch-site|citation|community|newsletter|subreddit|marketplace]...
                [--include-unknown-pricing] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dest SLUG]...
                (assisted targets are included unless --auto-only; --auto-only defaults to a 100 minimum)
  campaign list | preview ID | approve ID | run ID | status ID [--json] | pause ID | cancel ID
  pause-all | resume
  queue                                  jobs waiting for a person
  submission get ID | reconcile ID | requeue ID
  report export ID [--format markdown|json|csv]
  effort log --minutes M --activity TEXT [--campaign ID]

Plan, codes and invites (signed in)
  plan                                   your plan and Pro days
  redeem CODE                            redeem a credit code for Pro days
  invites [list] | invites create [--note TEXT] | invites accept CODE

Credit codes (admin, local database)
  credits mint --days N [--max 1] [--expires-days D] [--label L]   prints the code once
  credits list | credits revoke ID

Run
  worker [--once] [--interval-ms 5000]
  serve [--port 8787] [--no-worker]
  mcp --stdio
  tui

Data lives in $SUBMITFLEET_HOME (default ~/.local/share/submitfleet); set SUBMITFLEET_DB_URL for Turso.
Machine output goes to stdout, diagnostics to stderr.`;

const out = (v: unknown) => process.stdout.write(typeof v === 'string' ? (v.endsWith('\n') ? v : `${v}\n`) : `${JSON.stringify(v, null, 2)}\n`);
const log = (s: string) => process.stderr.write(`${s}\n`);

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

async function confirmTty(question: string, expect: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new SubmitFleetError('interactive_owner_required', 'approval needs an interactive owner terminal or the dashboard; agents cannot sign approvals');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question}\nType "${expect}" to confirm: `);
  rl.close();
  return answer.trim() === expect;
}

async function promptLine(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

function parseFields(list: string[] | undefined): Record<string, Record<string, unknown>> {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const f of list ?? []) {
    const m = /^([a-z0-9-]+)\.([a-z0-9_]+)=(.*)$/i.exec(f);
    if (!m) throw new SubmitFleetError('invalid_request', `--field must look like dest.key=value, got ${f}`);
    const [, dest, k, raw] = m;
    fields[dest!] ??= {};
    fields[dest!]![k!] = /^-?\d+(\.\d+)?$/.test(raw!) ? Number(raw) : raw;
  }
  return fields;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: o, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      role: { type: 'string' },
      label: { type: 'string' },
      source: { type: 'string' },
      license: { type: 'string' },
      set: { type: 'string' },
      reason: { type: 'string' },
      'min-supported': { type: 'string' },
      name: { type: 'string' },
      tagline: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string', multiple: true },
      logo: { type: 'string' },
      field: { type: 'string', multiple: true },
      email: { type: 'string' },
      product: { type: 'string' },
      'free-only': { type: 'boolean' },
      'auto-only': { type: 'boolean' },
      channel: { type: 'string', multiple: true },
      'include-unknown-pricing': { type: 'boolean' },
      'min-executable-destinations': { type: 'string' },
      'spend-limit-cents': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      dest: { type: 'string', multiple: true },
      format: { type: 'string' },
      minutes: { type: 'string' },
      activity: { type: 'string' },
      campaign: { type: 'string' },
      once: { type: 'boolean' },
      'interval-ms': { type: 'string' },
      port: { type: 'string' },
      'no-worker': { type: 'boolean' },
      stdio: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      local: { type: 'boolean' },
      url: { type: 'string' },
      'no-browser': { type: 'boolean' },
      key: { type: 'string' },
      days: { type: 'string' },
      max: { type: 'string' },
      'expires-days': { type: 'string' },
      note: { type: 'string' },
    },
  });
  const [cmd, sub, arg] = pos;
  if (!cmd || o.help || cmd === 'help') {
    out(HELP);
    return cmd || o.help ? EXIT.ok : EXIT.usage;
  }
  if (cmd === 'version' || cmd === '--version') {
    out(JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version);
    return EXIT.ok;
  }

  // Account commands, and the hosted account whenever the CLI is signed in.
  if (cmd === 'login') {
    try {
      const url = String(o.url ?? process.env.SUBMITFLEET_URL ?? DEFAULT_URL);
      if (o.key !== undefined) {
        // --key - reads the key from stdin so it stays out of shell history.
        let key = String(o.key);
        if (key === '-' || key === 'true') key = readFileSync(0, 'utf8').trim();
        const a = await loginWithKey(url, key);
        const who = (await remote('GET', '/api/me')) as { role?: string; workspace_id?: string };
        out({ signed_in: true, url: a.url, with: 'api_key', role: who.role ?? null, workspace_id: who.workspace_id ?? null });
        return EXIT.ok;
      }
      const a = await login(String(o.url ?? process.env.SUBMITFLEET_URL ?? DEFAULT_URL), log, { open: !o['no-browser'] });
      const who = (await remote('GET', '/api/me')) as { user?: { email?: string } };
      out({ signed_in: true, url: a.url, email: who.user?.email ?? null });
      return EXIT.ok;
    } catch (e) {
      out({ error: e instanceof SubmitFleetError ? e.code : 'login_failed', message: e instanceof Error ? e.message : String(e) });
      return EXIT.error;
    }
  }
  if (cmd === 'logout') return out({ signed_out: await logout() }), EXIT.ok;
  const remoteMode = !!readAuth() && !o.local && !process.env.SUBMITFLEET_LOCAL;
  if (remoteMode) {
    const r = await runRemote(cmd, sub, arg, o);
    if (r !== null) return r;
  } else if (cmd === 'whoami') {
    log('Not signed in: run submitfleet login (this CLI is using its local database).');
    return EXIT.error;
  }

  const fleet = await SubmitFleet.open(loadConfig());
  const ws = await ensureDefaultWorkspace(fleet.db);
  // Local CLI access implies filesystem access to the database: it acts as the owner.
  const owner: Actor = { workspaceId: ws, role: 'owner', id: 'local-cli' };
  const num = (v: unknown, d?: number) => (v === undefined ? d : Number(v));
  try {
    switch (cmd) {
      case 'credits': {
        if (sub === 'mint') {
          if (!o.days) return usage('--days is required');
          const m = await fleet.rewards.mint({ days: Number(o.days), maxRedemptions: o.max ? Number(o.max) : 1, expiresInDays: o['expires-days'] ? Number(o['expires-days']) : null, label: o.label as string | undefined, createdBy: 'cli' });
          log('Give this code to the person. It is shown once; only its hash is stored.');
          out({ code: m.code, id: m.id, days: m.grant.amount, max_redemptions: m.maxRedemptions, expires_at: m.expiresAt ? new Date(m.expiresAt).toISOString() : null, label: m.label });
          return EXIT.ok;
        }
        if (sub === 'list') return out(await fleet.rewards.credits.list()), EXIT.ok;
        if (sub === 'revoke' && arg) return await fleet.rewards.credits.revoke(arg), out({ revoked: arg }), EXIT.ok;
        return usage();
      }
      case 'init': {
        const k = await createApiKey(fleet.db, ws, 'owner', 'local owner');
        log('Workspace ready. Store this owner key now; it is not shown again:');
        out({ workspace_id: ws, owner_key: k.token });
        return EXIT.ok;
      }
      case 'doctor': {
        const checks = await fleet.doctor();
        out(o.json ? checks : checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.check}: ${c.detail ?? ''}`).join('\n'));
        return checks.find((c) => c.check === 'database')?.ok ? EXIT.ok : EXIT.error;
      }
      case 'keys': {
        if (sub !== 'create') return usage();
        const role = (o.role ?? 'agent') as Role;
        if (role !== 'owner' && role !== 'agent') return usage('--role must be owner or agent');
        const k = await createApiKey(fleet.db, ws, role, String(o.label ?? `${role} key`));
        log('Store this key now; it is not shown again.');
        out({ id: k.id, role, token: k.token });
        return EXIT.ok;
      }
      case 'catalog': {
        if (sub === 'seed') return out(await fleet.loadBundledCatalog()), EXIT.ok;
        if (sub === 'search') {
          const ds = await fleet.catalogSearch(arg);
          out(o.json ? ds : ds.map((d) => `${d.slug}\t${d.kind}\t${d.fee_status}\t${d.automation_method}\t${d.adapter_health}`).join('\n') || 'no destinations');
          return EXIT.ok;
        }
        if (sub === 'get' && arg) return out(await fleet.catalogGet(arg)), EXIT.ok;
        if (sub === 'import' && arg) {
          if (!o.source || !o.license) return usage('--source and --license are required');
          const records = JSON.parse(readFileSync(arg, 'utf8')) as ImportRecord[];
          out(await fleet.catalogImport(owner, records, String(o.source), String(o.license)));
          return EXIT.ok;
        }
        if (sub === 'health' && arg && o.set && o.reason) {
          await fleet.catalogSetHealth(owner, arg, o.set as 'healthy', String(o.reason));
          out(await fleet.catalogGet(arg));
          return EXIT.ok;
        }
        return usage();
      }
      case 'coverage': {
        const c = await fleet.coverageReport();
        const min = num(o['min-supported'], c.release_minimum)!;
        if (o.json) out(c);
        else
          out(
            [
              `discovered            ${c.discovered}`,
              `source-labeled free   ${c.source_labeled_free}`,
              `verified free         ${c.verified_free}`,
              `permission reviewed   ${c.permission_reviewed}`,
              `live tested           ${c.live_tested}`,
              `release qualifying    ${c.release_qualifying} / ${min} ${c.release_qualifying >= min ? '(meets minimum)' : '(below_minimum)'}`,
            ].join('\n'),
          );
        return c.release_qualifying >= min ? EXIT.ok : EXIT.gate;
      }
      case 'products': {
        if (sub === 'add' && arg) {
          const p = await fleet.productCreate(owner, {
            url: arg,
            name: o.name as string | undefined,
            tagline: o.tagline as string | undefined,
            description: o.description as string | undefined,
            categories: o.category as string[] | undefined,
            logo_path: o.logo as string | undefined,
            destination_fields: parseFields(o.field as string[] | undefined),
          });
          out(p);
          log('Review the facts, then approve them with: submitfleet products approve ' + p.id);
          return EXIT.ok;
        }
        if (sub === 'list') return out(await fleet.productList(owner)), EXIT.ok;
        if (sub === 'get' && arg) return out(await fleet.productGet(owner, arg)), EXIT.ok;
        if (sub === 'approve' && arg) {
          const p = await fleet.productGet(owner, arg);
          log(JSON.stringify({ url: p.url, name: p.name, tagline: p.tagline, description: p.description, categories: p.categories, logo_path: p.logo_path, destination_fields: p.destination_fields }, null, 2));
          if (!(await confirmTty('Approve these facts for use in submissions?', 'approve'))) return log('Not approved.'), EXIT.error;
          out(await fleet.productApproveFacts(owner, arg));
          return EXIT.ok;
        }
        return usage();
      }
      case 'accounts': {
        if (sub === 'list') return out(await fleet.accountStatus(owner)), EXIT.ok;
        if (sub === 'disconnect' && arg) return await fleet.accountDisconnect(owner, arg), out({ disconnected: arg }), EXIT.ok;
        if (sub === 'connect' && arg && o.email) {
          await fleet.accountConnectStart(owner, arg, String(o.email));
          if (!process.stdin.isTTY) throw new SubmitFleetError('interactive_owner_required', 'enter the emailed code in an interactive terminal or the dashboard');
          const code = await promptLine(`Enter the code ${arg} emailed to ${o.email}: `);
          const a = await fleet.accountConnectFinish(owner, arg, String(o.email), code);
          out(a);
          return EXIT.ok;
        }
        return usage();
      }
      case 'campaign': {
        if (sub === 'plan') {
          if (!o.product) return usage('--product is required');
          const plan = await fleet.campaignPlan(owner, {
            productId: String(o.product),
            minExecutableDestinations: num(o['min-executable-destinations']),
            spendLimitCents: num(o['spend-limit-cents'], 0),
            earliestDate: o.from as string | undefined,
            latestDate: o.to as string | undefined,
            destinations: o.dest as string[] | undefined,
            mode: o['auto-only'] ? 'auto_only' : 'all',
            channels: o.channel as string[] | undefined,
            includeUnknownPricing: !!o['include-unknown-pricing'],
          });
          out(o.json ? plan : { campaign: plan.campaign.id, status: plan.campaign.status, counts: plan.counts, blocked: plan.targets.filter((t) => !t.executable).slice(0, 50) });
          return plan.campaign.status === 'coverage_insufficient' ? EXIT.gate : EXIT.ok;
        }
        if (sub === 'list') return out(await fleet.campaignList(owner)), EXIT.ok;
        if (!arg) return usage();
        if (sub === 'preview') return out(await fleet.campaignPreview(owner, arg)), EXIT.ok;
        if (sub === 'approve') {
          const p = await fleet.campaignPreview(owner, arg);
          log(`${p.executable.length} free submissions; listing spend $0; operating limit $${(p.campaign.spend_limit_cents / 100).toFixed(2)}`);
          log(p.executable.map((e) => `  - ${e.destination}`).join('\n'));
          const req = await fleet.approvalRequest(owner, arg);
          if (!(await confirmTty(`Scope ${req.scope_hash}`, req.scope_hash.slice(0, 8)))) return log('Not approved.'), EXIT.error;
          out(await fleet.approvalGrant({ ...owner, id: 'local-owner-tty' }, arg, req.scope_hash));
          return EXIT.ok;
        }
        if (sub === 'run') return out(await fleet.campaignRun(owner, arg)), EXIT.ok;
        if (sub === 'status') return out(await fleet.campaignStatus(owner, arg)), EXIT.ok;
        if (sub === 'pause') return await fleet.campaignPause(owner, arg), out({ paused: arg }), EXIT.ok;
        if (sub === 'cancel') return out({ ...(await fleet.campaignCancel(owner, arg)), remote_listings_deleted: false }), EXIT.ok;
        return usage();
      }
      case 'pause-all':
        await fleet.pauseAll(owner);
        out({ paused: true });
        return EXIT.ok;
      case 'resume':
        await fleet.resumeAll(owner);
        out({ paused: false });
        return EXIT.ok;
      case 'queue': {
        const q = await fleet.humanQueue(owner);
        out(o.json ? q : q.map((i) => `${i.id}\t${i.destination}\t${i.state}\t${i.reason_code ?? ''}`).join('\n') || 'nothing waiting');
        return q.length ? EXIT.needs_human : EXIT.ok;
      }
      case 'submission': {
        if (!arg) return usage();
        if (sub === 'get') return out(await fleet.submissionGet(owner, arg)), EXIT.ok;
        if (sub === 'reconcile') return out({ state: await fleet.submissionReconcile(owner, arg) }), EXIT.ok;
        if (sub === 'requeue') return out({ requeued: await fleet.submissionRequeue(owner, arg) }), EXIT.ok;
        return usage();
      }
      case 'report': {
        if (sub !== 'export' || !arg) return usage();
        const f = String(o.format ?? 'markdown');
        if (!['markdown', 'json', 'csv'].includes(f)) return usage('--format must be markdown, json or csv');
        out(await fleet.reportExport(owner, arg, f as 'markdown'));
        return EXIT.ok;
      }
      case 'effort': {
        if (sub !== 'log' || !o.minutes || !o.activity) return usage();
        await fleet.logEffort(owner, (o.campaign as string) ?? null, String(o.activity), Number(o.minutes));
        out({ ok: true });
        return EXIT.ok;
      }
      case 'worker': {
        const w = fleet.worker();
        if (o.once) return out(await w.tick(50)), EXIT.ok;
        await loop(w, num(o['interval-ms'], 5000)!);
        return EXIT.ok;
      }
      case 'serve': {
        const loaded = await fleet.loadBundledCatalog();
        log(`catalog: ${loaded.created} added, ${loaded.updated} refreshed, ${loaded.seeded} reviewed records applied`);
        const port = num(o.port, Number(process.env.PORT ?? 8787))!;
        const app = buildApp(fleet, {
          allowedOrigins: (process.env.SUBMITFLEET_ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
          mailer: resendMailer(process.env.RESEND_API_KEY, process.env.SUBMITFLEET_MAIL_FROM ?? 'SubmitFleet <hello@submitfleet.com>'),
          publicOrigin: process.env.SUBMITFLEET_PUBLIC_ORIGIN,
        });
        if (!process.env.RESEND_API_KEY) log('RESEND_API_KEY is not set: sign-in emails are printed here instead of sent');
        serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' });
        log(`submitfleet listening on http://${process.env.HOST ?? '127.0.0.1'}:${port}`);
        if (!o['no-worker']) await loop(fleet.worker(), Number(process.env.SUBMITFLEET_WORKER_INTERVAL_MS ?? 5000));
        else await new Promise(() => {});
        return EXIT.ok;
      }
      case 'mcp': {
        const server = buildMcpServer(fleet, { workspaceId: ws, role: 'agent', id: 'mcp-stdio' });
        await server.connect(new StdioServerTransport());
        log('submitfleet MCP server on stdio');
        await new Promise(() => {});
        return EXIT.ok;
      }
      case 'tui':
        await runTui(fleet, owner);
        return EXIT.ok;
      default:
        return usage(`unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof SubmitFleetError) {
      out({ error: e.code, message: e.message, detail: e.detail ?? null });
      return e.code === 'coverage_insufficient' ? EXIT.gate : EXIT.error;
    }
    log(String(e instanceof Error ? (e.stack ?? e.message) : e));
    return EXIT.error;
  } finally {
    if (!['serve', 'mcp', 'worker', 'tui'].includes(cmd)) fleet.close();
  }

  function usage(msg?: string): number {
    if (msg) log(msg);
    log('Run `submitfleet help` for usage.');
    return EXIT.usage;
  }
}

async function loop(w: ReturnType<SubmitFleet['worker']>, intervalMs: number): Promise<void> {
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => (stop = true));
  log(`worker ${w.id} polling every ${intervalMs} ms`);
  while (!stop) {
    try {
      const r = await w.tick(10);
      if (r.executed || r.recovered || r.reconciled) log(`[worker] ${JSON.stringify(r)}`);
    } catch (e) {
      log(`[worker] tick failed: ${String(e)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => {
    process.exitCode = code;
  });
}

/** Commands served by the hosted account. Returns null for commands that only make sense locally. */
async function runRemote(cmd: string, sub: string | undefined, arg: string | undefined, o: Record<string, unknown>): Promise<number | null> {
  try {
    const show = (v: unknown) => (out(v), EXIT.ok);
    switch (cmd) {
      case 'whoami': {
        const a = await accessToken();
        const me = (await remote('GET', '/api/me')) as { user?: { email?: string }; role: string; workspace_id: string };
        return show({ url: a.url, email: me.user?.email ?? null, role: me.role, workspace_id: me.workspace_id });
      }
      case 'products':
        if (sub === 'list') return show(await remote('GET', '/products'));
        if (sub === 'get' && arg) return show(await remote('GET', `/products/${encodeURIComponent(arg)}`));
        if (sub === 'add' && arg) {
          const facts = (await remote('POST', '/products/extract', { url: arg }).catch(() => ({}))) as Record<string, string | null>;
          return show(await remote('POST', '/products', {
            url: arg,
            name: (o.name as string) ?? facts.name ?? null,
            tagline: (o.tagline as string) ?? facts.tagline ?? null,
            description: (o.description as string) ?? facts.description ?? null,
            categories: (o.category as string[]) ?? [],
          }));
        }
        return null;
      case 'catalog':
        if (sub === 'search') return show(await remote('GET', `/catalog?limit=500${arg ? `&q=${encodeURIComponent(arg)}` : ''}`));
        if (sub === 'get' && arg) return show(await remote('GET', `/catalog/${encodeURIComponent(arg)}`));
        return null;
      case 'coverage':
        return show(await remote('GET', '/coverage'));
      case 'campaign':
        if (sub === 'list') return show(await remote('GET', '/campaigns'));
        if (sub === 'plan') {
          if (!o.product) return null;
          return show(await remote('POST', '/campaigns', {
            product_id: o.product,
            min_executable_destinations: o['min-executable-destinations'] ? Number(o['min-executable-destinations']) : undefined,
            mode: o['auto-only'] ? 'auto_only' : 'all',
            channels: o.channel,
            include_unknown_pricing: !!o['include-unknown-pricing'],
            destinations: o.dest,
          }));
        }
        if (!arg) return null;
        if (sub === 'status') return show(await remote('GET', `/campaigns/${arg}/status`));
        if (sub === 'preview') return show(await remote('GET', `/campaigns/${arg}/preview`));
        if (sub === 'queue') return show(await remote('GET', `/campaigns/${arg}/queue`));
        if (sub === 'run') return show(await remote('POST', `/campaigns/${arg}/run`));
        if (sub === 'pause') return show(await remote('POST', `/campaigns/${arg}/pause`));
        if (sub === 'cancel') return show(await remote('POST', `/campaigns/${arg}/cancel`));
        if (sub === 'approve') {
          log('Approve campaigns in the web app: the CLI only requests approval.');
          return show(await remote('POST', `/campaigns/${arg}/approval-request`));
        }
        return null;
      case 'queue':
        return show(await remote('GET', '/human-queue'));
      case 'plan':
        return show(await remote('GET', '/plan'));
      case 'redeem':
        if (!sub) return null;
        return show(await remote('POST', '/credits/redeem', { code: sub }));
      case 'invites':
        if (!sub || sub === 'list') return show(await remote('GET', '/invites'));
        if (sub === 'create') {
          const inv = (await remote('POST', '/invites', { note: (o.note as string) ?? undefined })) as { code: string };
          const a = await accessToken();
          return show({ ...inv, link: `${a.url.replace(/\/+$/, '')}/i/${inv.code}` });
        }
        if (sub === 'accept' && arg) return show(await remote('POST', '/invites/accept', { code: arg }));
        return null;
      case 'submission':
        if (sub === 'get' && arg) return show(await remote('GET', `/submissions/${arg}`));
        if (sub === 'kit' && arg) return show(await remote('GET', `/submissions/${arg}/kit`));
        return null;
      case 'report':
        if (sub === 'export' && arg) return show(await remote('GET', `/reports/${arg}?format=${String(o.format ?? 'markdown')}`));
        return null;
      case 'mcp':
        await mcpStdioProxy();
        return EXIT.ok;
      default:
        return null;
    }
  } catch (e) {
    out({ error: e instanceof SubmitFleetError ? e.code : 'error', message: e instanceof Error ? e.message : String(e), detail: e instanceof SubmitFleetError ? (e.detail ?? null) : null });
    return EXIT.error;
  }
}
