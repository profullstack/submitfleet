// Mobile-first dashboard. Plain HTML + one same-origin script, so the CSP can forbid
// inline script. The browser only talks to /api/v1 with the user's bearer key.

export const LANDING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SubmitFleet</title>
<meta name="description" content="One product profile. Coordinated submissions. Proof of what went live.">
<style>
:root{--bg:#fbfbf8;--fg:#17181a;--muted:#5d6168;--accent:#0b6e4f;--line:#e2e2dc}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#ecede8;--muted:#a3a7ad;--accent:#4fc39a;--line:#2a2c30}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:3rem 16px}
h1{font-size:2rem;margin:0 0 .25rem}p{color:var(--muted)}a{color:var(--accent)}
code{background:var(--line);padding:.1rem .35rem;border-radius:4px}
</style></head><body><main>
<h1>SubmitFleet</h1>
<p>One product profile. Coordinated submissions. Proof of what went live.</p>
<p>An open-source, self-hostable engine for launch-site and directory submissions: maintained adapters, owner-approved campaigns, durable workers, receipts and verified listings. Free listings only by default.</p>
<p>Status: early engine. Destination coverage is reported honestly by <code>submitfleet coverage report</code>; it is below the 100-destination release gate today.</p>
<p><a href="/app">Dashboard</a> · <a href="https://github.com/profullstack/submitfleet">Source</a></p>
</main></body></html>`;

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SubmitFleet Dashboard</title>
<style>
:root{--bg:#fbfbf8;--card:#fff;--fg:#17181a;--muted:#5d6168;--accent:#0b6e4f;--warn:#9a5b00;--bad:#b42318;--line:#e2e2dc}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--card:#1a1c1f;--fg:#ecede8;--muted:#a3a7ad;--accent:#4fc39a;--warn:#e0a54a;--bad:#f07167;--line:#2a2c30}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;z-index:1}
header h1{font-size:1.05rem;margin:0 auto 0 0}
nav{display:flex;gap:4px;overflow-x:auto;padding:8px 16px;border-bottom:1px solid var(--line)}
nav button{white-space:nowrap}
main{max-width:56rem;margin:0 auto;padding:16px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:8px 12px;min-height:40px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--bad)}
button[aria-selected=true]{border-color:var(--accent);color:var(--accent)}
input,textarea{font:inherit;width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:8px}
.stat b{display:block;font-size:1.4rem}.stat span{color:var(--muted);font-size:.85rem}
.muted{color:var(--muted)}.warn{color:var(--warn)}.bad{color:var(--bad)}.good{color:var(--accent)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:60vh;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{padding:6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.scroll{overflow-x:auto}
#toast{position:fixed;left:16px;right:16px;bottom:16px;max-width:30rem;margin:auto;background:var(--fg);color:var(--bg);padding:10px 14px;border-radius:10px;display:none}
</style></head><body>
<header><h1>SubmitFleet</h1><span id="who" class="muted"></span><button id="pauseAll" class="danger" title="Stop all new outbound writes">Pause all</button></header>
<nav id="tabs">
<button data-tab="coverage" aria-selected="true">Coverage</button>
<button data-tab="products">Portfolio</button>
<button data-tab="campaigns">Campaigns</button>
<button data-tab="queue">Human actions</button>
<button data-tab="accounts">Accounts</button>
</nav>
<main>
<section id="login" class="card" hidden>
<p>Paste a SubmitFleet API key. It stays in this browser tab only.</p>
<div class="row"><input id="key" type="password" autocomplete="off" placeholder="sf_own_..."><button id="saveKey" class="primary">Use key</button></div>
<p class="muted">Create one with <code>submitfleet keys create --role owner</code>.</p>
</section>
<section id="view"></section>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script src="/app/app.js"></script>
</body></html>`;

export const DASHBOARD_JS = String.raw`(() => {
  const $ = (s) => document.querySelector(s);
  let key = null;
  try { key = sessionStorage.getItem('sf_key'); } catch {}
  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = 'none'), 3500); };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function api(path, opts = {}) {
    const res = await fetch('/api/v1' + path, { ...opts, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...(opts.headers || {}) } });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((data && data.error ? data.error + ': ' + (data.message || '') : 'HTTP ' + res.status));
    return data;
  }
  function showLogin() { $('#login').hidden = false; $('#view').innerHTML = ''; }
  $('#saveKey').onclick = () => { key = $('#key').value.trim(); try { sessionStorage.setItem('sf_key', key); } catch {} $('#login').hidden = true; boot(); };

  async function copyText(text, fallbackHost) {
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      toast('Copied Markdown');
    } catch {
      fallbackHost.innerHTML = '<p class="warn">Clipboard is unavailable here. The text below is selected: copy it manually.</p><textarea rows="12" readonly></textarea>';
      const ta = fallbackHost.querySelector('textarea'); ta.value = text; ta.focus(); ta.select();
    }
  }
  async function download(path, name) {
    const res = await fetch('/api/v1' + path, { headers: { authorization: 'Bearer ' + key } });
    if (!res.ok) return toast('Download failed: HTTP ' + res.status);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const views = {
    async coverage(v) {
      const c = await api('/coverage');
      const stages = ['discovered', 'source_labeled_free', 'verified_free', 'permission_reviewed', 'live_tested', 'release_qualifying'];
      const blockers = Object.entries(c.blocker_counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
      v.innerHTML = '<div class="card"><h2>Engine coverage</h2><p class="' + (c.status === 'release_ready' ? 'good' : 'warn') + '">' + c.release_qualifying + ' of ' + c.release_minimum + ' required qualifying destinations (' + esc(c.status) + ')</p><div class="stats">' +
        stages.map((s) => '<div class="stat"><b>' + c[s] + '</b><span>' + s.replace(/_/g, ' ') + '</span></div>').join('') + '</div></div>' +
        '<div class="card"><h3>Top blockers</h3><table>' + blockers.map(([b, n]) => '<tr><td>' + esc(b) + '</td><td>' + n + '</td></tr>').join('') + '</table></div>';
    },
    async products(v) {
      const ps = await api('/products');
      v.innerHTML = '<div class="card"><h2>Portfolio</h2>' + (ps.length ? '' : '<p class="muted">No products yet. Add one with <code>submitfleet products add URL</code>.</p>') +
        ps.map((p) => '<div class="card"><b>' + esc(p.name || p.url) + '</b><div class="muted">' + esc(p.url) + '</div><div>' + (p.approved_at ? '<span class="good">facts approved</span>' : '<span class="warn">facts not approved</span>') + '</div><div class="row"><code>' + esc(p.id) + '</code></div></div>').join('') + '</div>';
    },
    async campaigns(v) {
      const cs = await api('/campaigns');
      v.innerHTML = '<h2>Campaigns</h2>' + (cs.length ? '' : '<p class="muted">No campaigns yet.</p>') + cs.map((c) =>
        '<div class="card" data-id="' + esc(c.id) + '"><div class="row"><b>' + esc(c.id) + '</b><span class="' + (c.status === 'coverage_insufficient' ? 'warn' : 'muted') + '">' + esc(c.status) + '</span></div>' +
        '<p>' + c.executable_count + ' executable of ' + c.min_executable + ' required · spend limit $' + (c.spend_limit_cents / 100).toFixed(2) + ' · listing fees $0.00</p>' +
        '<div class="row"><button data-act="preview">Preview</button><button data-act="approve" class="primary">Approve</button><button data-act="run">Run</button><button data-act="status">Status</button><button data-act="pause">Pause</button><button data-act="cancel" class="danger">Cancel</button><button data-act="report">Report</button></div><div class="out"></div></div>').join('');
      v.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => act(b.closest('[data-id]').dataset.id, b.dataset.act, b.closest('.card').querySelector('.out'))));
    },
    async queue(v) {
      const q = await api('/human-queue');
      v.innerHTML = '<div class="card"><h2>Human actions</h2>' + (q.length ? '<div class="scroll"><table><tr><th>Destination</th><th>State</th><th>Reason</th><th></th></tr>' +
        q.map((i) => '<tr><td>' + esc(i.destination) + '</td><td>' + esc(i.state) + '</td><td>' + esc(i.reason_code) + '</td><td>' + (i.state === 'needs_human' ? '<button data-requeue="' + esc(i.id) + '">Requeue</button>' : '') + '</td></tr>').join('') + '</table></div>' : '<p class="muted">Nothing is waiting for you.</p>') +
        '<p class="muted">Some steps (captchas, payments, logins) need a desktop browser at the destination; they cannot be done from here.</p></div>';
      v.querySelectorAll('[data-requeue]').forEach((b) => (b.onclick = async () => { await api('/submissions/' + b.dataset.requeue + '/requeue', { method: 'POST' }); toast('Requeued'); views.queue(v); }));
    },
    async accounts(v) {
      const as = await api('/accounts');
      v.innerHTML = '<div class="card"><h2>Accounts</h2>' + (as.length ? '<table>' + as.map((a) => '<tr><td>' + esc(a.label) + '</td><td>' + esc(a.status) + '</td><td>' + esc(a.expires_at || '') + '</td></tr>').join('') + '</table>' : '<p class="muted">No connected accounts.</p>') +
        '<p class="muted">Connect accounts with <code>submitfleet accounts connect DESTINATION --email you@example.com</code>. Codes and passwords never pass through an agent.</p></div>';
    },
  };

  async function act(id, what, out) {
    try {
      if (what === 'preview') { const p = await api('/campaigns/' + id + '/preview'); out.innerHTML = '<p>' + p.executable.length + ' executable, ' + p.blocked.length + ' blocked. Scope <code>' + esc(p.scope_hash.slice(0, 12)) + '</code></p><pre>' + esc(JSON.stringify(p.executable.map((e) => e.destination), null, 1)) + '</pre>'; }
      if (what === 'approve') {
        const p = await api('/campaigns/' + id + '/preview');
        if (!confirm('Approve ' + p.executable.length + ' free submissions for this campaign?\nListing spend: $0. Operating limit: $' + (p.campaign.spend_limit_cents / 100).toFixed(2) + '\nScope ' + p.scope_hash.slice(0, 12))) return;
        await api('/campaigns/' + id + '/approve', { method: 'POST', body: JSON.stringify({ scope_hash: p.scope_hash }) }); toast('Approved');
      }
      if (what === 'run') { const r = await api('/campaigns/' + id + '/run', { method: 'POST' }); toast('Queued ' + r.queued); }
      if (what === 'status') { const s = await api('/campaigns/' + id + '/status'); out.innerHTML = '<pre>' + esc(JSON.stringify(s.intents, null, 1)) + '</pre>'; }
      if (what === 'pause') { await api('/campaigns/' + id + '/pause', { method: 'POST' }); toast('Paused'); }
      if (what === 'cancel') { if (!confirm('Cancel unsent work? Listings that already exist stay live.')) return; const r = await api('/campaigns/' + id + '/cancel', { method: 'POST' }); toast('Canceled ' + r.canceled + '; ' + r.already_external + ' already sent'); }
      if (what === 'report') {
        const md = await api('/reports/' + id + '?format=markdown');
        out.innerHTML = '<div class="row"><button class="primary" data-copy>Copy Markdown</button><button data-dl="markdown">.md</button><button data-dl="json">.json</button><button data-dl="csv">.csv</button></div><div class="fallback"></div><pre></pre>';
        out.querySelector('pre').textContent = md;
        out.querySelector('[data-copy]').onclick = () => copyText(md, out.querySelector('.fallback'));
        out.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => download('/reports/' + id + '?format=' + b.dataset.dl, id + '.' + (b.dataset.dl === 'markdown' ? 'md' : b.dataset.dl))));
      }
    } catch (e) { toast(String(e.message || e)); }
  }

  let current = 'coverage';
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { current = b.dataset.tab; document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); render(); }));
  $('#pauseAll').onclick = async () => { if (!confirm('Stop all new outbound writes now?')) return; await api('/pause', { method: 'POST' }); toast('All outbound writes paused'); };
  async function render() { try { await views[current]($('#view')); } catch (e) { if (String(e.message) !== 'unauthorized') $('#view').innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; } }
  async function boot() {
    if (!key) return showLogin();
    try { const w = await api('/whoami'); $('#who').textContent = w.role; render(); } catch {}
  }
  boot();
})();
`;

export const INSTALL_SH = `#!/bin/sh
# SubmitFleet CLI installer: curl -fsSL https://submitfleet.com/install.sh | sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "submitfleet needs Node.js 22.5 or newer: https://nodejs.org/" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "submitfleet needs Node.js 22.5 or newer (found $(node -v))" >&2
  exit 1
fi
# npm first: its global bin works out of the box. pnpm only when npm is missing or fails
# (pnpm add -g aborts unless its global bin directory was set up beforehand).
if command -v npm >/dev/null 2>&1 && npm install -g @profullstack/submitfleet; then
  bin_dir="$(npm prefix -g)/bin"
elif command -v pnpm >/dev/null 2>&1 && pnpm add -g @profullstack/submitfleet; then
  bin_dir="$(pnpm bin -g)"
else
  echo "submitfleet: install failed (tried npm and pnpm)" >&2
  exit 1
fi
if command -v submitfleet >/dev/null 2>&1; then
  submitfleet doctor || true
  echo "Installed. Try: submitfleet coverage report"
else
  echo "Installed to $bin_dir, which is not on your PATH. Add it, then run: submitfleet doctor"
fi
`;
