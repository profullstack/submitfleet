import { createPasskey, passkeysSupported } from './webauthn.js';

// ── Tiny DOM helpers: every value goes in as text, never as HTML ──
const $ = (s, root = document) => root.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const fmt = (n) => (n == null ? '–' : Intl.NumberFormat(undefined, { notation: n >= 10000 ? 'compact' : 'standard' }).format(n));
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.style.display = 'none'), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path.startsWith('/api') ? path : `/api/v1${path}`, {
    credentials: 'same-origin',
    ...opts,
    headers: { ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new Error('signed out');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data;
}
const post = (p, body) => api(p, { method: 'POST', body: JSON.stringify(body ?? {}) });

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
    return true;
  } catch {
    // Clipboard blocked (permissions, insecure context): show the text selected instead.
    const ta = h('textarea', { class: 'token', readonly: true, rows: 4 });
    ta.value = text;
    const dlg = h('div', { class: 'notice warn' }, 'Copy is blocked here. The text is selected: copy it manually.', ta);
    $('#view').prepend(dlg);
    ta.focus();
    ta.select();
    return false;
  }
}

const STATE = {
  needs_human: ['Your turn', 'amber'],
  queued: ['Queued', 'blue'],
  executing: ['Submitting', 'blue'],
  uncertain: ['Checking', 'amber'],
  submitted: ['Submitted', 'blue'],
  scheduled: ['Scheduled', 'blue'],
  under_review: ['In review', 'blue'],
  published_verified: ['Live', 'green'],
  rejected: ['Rejected', 'red'],
  removal_observed: ['Removed', 'red'],
  failed: ['Skipped', ''],
  canceled: ['Canceled', ''],
};
const pill = (state, reason) => {
  const [label, color] = STATE[state] || [state, ''];
  return h('span', { class: `pill ${color}`, title: reason || '' }, state === 'failed' && reason && !reason.startsWith('skipped') ? 'Failed' : label);
};
const CHANNELS = [
  ['directory', 'Directories'],
  ['product-launch-site', 'Launch sites'],
  ['citation', 'Business citations'],
  ['community', 'Communities'],
  ['newsletter', 'Newsletters'],
  ['subreddit', 'Subreddits'],
  ['marketplace', 'Marketplaces'],
];
const channelName = (c) => (CHANNELS.find((x) => x[0] === c) || [c, c])[1];
const PRICING = { source_labeled_free: ['Free', 'green'], verified_free: ['Free (verified)', 'green'], paid: ['Paid', 'red'], conditional_free: ['Conditions', 'amber'], unknown: ['Price unknown', ''] };
const pricePill = (p) => h('span', { class: `pill ${PRICING[p]?.[1] || ''}` }, PRICING[p]?.[0] || p);
const logoEl = (p, cls = 'logo') =>
  p.logo_path ? h('img', { class: cls, src: `/p/${p.id}/logo?v=${encodeURIComponent(p.updated_at)}`, alt: '' }) : h('div', { class: cls }, (p.name || p.url || '?').replace(/^https?:\/\/(www\.)?/, '').charAt(0).toUpperCase());

function pageHead(title, sub, ...actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), actions.length ? h('div', { class: 'btn-row' }, actions) : null);
}
const link = (href, text, cls) => h('a', { href, class: cls, 'data-link': true }, text);

// ── Router ──
const routes = [
  [/^\/app\/?$/, home],
  [/^\/app\/products\/?$/, productsPage],
  [/^\/app\/products\/new$/, newProduct],
  [/^\/app\/products\/([\w-]+)\/launch$/, launchPage],
  [/^\/app\/products\/([\w-]+)$/, productPage],
  [/^\/app\/campaigns\/?$/, campaignsPage],
  [/^\/app\/campaigns\/([\w-]+)$/, campaignPage],
  [/^\/app\/destinations\/?$/, destinationsPage],
  [/^\/app\/settings\/?$/, settingsPage],
];
let me = null;
async function render() {
  const path = location.pathname;
  const view = $('#view');
  const section = path.split('/')[2] || 'home';
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      view.replaceChildren(h('div', { class: 'skeleton' }, 'Loading…'));
      try {
        const node = await fn(...m.slice(1));
        view.replaceChildren(node);
      } catch (e) {
        if (e.message !== 'signed out') view.replaceChildren(h('div', { class: 'notice bad' }, e.message));
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  view.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Not found'), link('/app', 'Back to overview', 'btn')));
}
function go(path) {
  history.pushState(null, '', path);
  render();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/app"]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.target !== '_blank') {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', render);

// ── Overview ──
async function home() {
  const [products, campaigns, queue] = await Promise.all([api('/products'), api('/campaigns'), api('/human-queue')]);
  const welcome = new URLSearchParams(location.search).get('welcome');
  const root = h('div');
  if (welcome) {
    history.replaceState(null, '', '/app');
    root.append(
      h('div', { class: 'notice ok' }, 'Your account is ready. ', passkeysSupported() ? h('span', {}, 'Add a passkey in ', link('/app/settings', 'Settings'), ' for one-tap sign-in next time.') : null),
    );
  }
  if (!products.length) {
    root.append(
      h('div', { class: 'card empty' },
        h('h2', {}, 'Add your first product'),
        h('p', {}, 'Paste your product URL. SubmitFleet drafts the listing details from your page, you review them once, then pick where to launch.'),
        link('/app/products/new', 'Add a product', 'btn primary lg')),
    );
    return root;
  }
  const waiting = queue.filter((q) => q.state === 'needs_human').length;
  const statuses = await Promise.all(campaigns.slice(0, 8).map((c) => api(`/campaigns/${c.id}/status`)));
  const live = statuses.reduce((n, s) => n + (s.intents.published_verified || 0), 0);
  const submitted = statuses.reduce((n, s) => n + (s.intents.submitted || 0) + (s.intents.scheduled || 0) + (s.intents.under_review || 0), 0);
  root.append(
    pageHead('Overview', null, link('/app/products/new', 'Add product', 'btn')),
    h('div', { class: 'grid3' },
      h('div', { class: 'card kpi' }, h('b', {}, fmt(waiting)), h('span', {}, 'waiting for you')),
      h('div', { class: 'card kpi' }, h('b', {}, fmt(submitted)), h('span', {}, 'submitted, awaiting review')),
      h('div', { class: 'card kpi' }, h('b', {}, fmt(live)), h('span', {}, 'live listings'))),
    h('div', { class: 'section-title' }, 'Products'),
    h('div', { class: 'grid2' }, products.map(productCard)),
  );
  if (campaigns.length) {
    root.append(h('div', { class: 'section-title' }, 'Recent campaigns'), campaignList(campaigns.slice(0, 8), statuses, products));
  }
  return root;
}

function productCard(p) {
  return h('a', { href: `/app/products/${p.id}`, class: 'card-link' },
    h('div', { class: 'card product-card' }, logoEl(p),
      h('div', { class: 'meta' }, h('b', {}, p.name || p.url), h('span', {}, p.tagline || p.url)),
      p.approved_at ? h('span', { class: 'pill green' }, 'Ready') : h('span', { class: 'pill amber' }, 'Needs review')));
}

function campaignList(campaigns, statuses, products) {
  return sizeBars(h('div', { class: 'list' }, campaigns.map((c, i) => {
    const st = statuses[i]?.intents || {};
    const total = Object.values(st).reduce((a, b) => a + b, 0) || c.executable_count;
    const live = st.published_verified || 0;
    const sub = (st.submitted || 0) + (st.scheduled || 0) + (st.under_review || 0);
    const skip = (st.failed || 0) + (st.rejected || 0) + (st.canceled || 0);
    const todo = st.needs_human || 0;
    const p = products.find((x) => x.id === c.product_id);
    return h('a', { href: `/app/campaigns/${c.id}`, class: 'card-link' },
      h('div', { class: 'item' }, p ? logoEl(p, 'fav') : h('span'),
        h('div', {},
          h('div', { class: 'title' }, `${p?.name || 'Campaign'} · ${fmt(total)} destinations`),
          h('div', { class: 'progress', 'data-total': total }, h('i', { class: 'live', 'data-w': live }), h('i', { class: 'sub', 'data-w': sub }), h('i', { class: 'skip', 'data-w': skip })),
          h('div', { class: 'sub' }, h('span', {}, `${todo} to do · ${sub} submitted · ${live} live`), h('span', {}, `· started ${when(c.created_at)}`))),
        h('span', { class: 'pill' }, c.status.replace(/_/g, ' '))));
  })));
}
// Width via CSSOM (allowed by CSP), not inline style attributes.
function sizeBars(node) {
  queueMicrotask(() => {
    for (const bar of document.querySelectorAll('.progress')) {
      const parts = [...bar.children];
      const total = Number(bar.dataset.total) || parts.reduce((n, p) => n + Number(p.dataset.w || 0), 0);
      for (const p of parts) p.style.width = total ? `${(100 * Number(p.dataset.w || 0)) / total}%` : '0';
    }
  });
  return node;
}

// ── Products ──
async function productsPage() {
  const products = await api('/products');
  return h('div', {}, pageHead('Products', 'Everything you launch, each with one approved profile.', link('/app/products/new', 'Add product', 'btn primary')),
    products.length ? h('div', { class: 'grid2' }, products.map(productCard)) : h('div', { class: 'card empty' }, h('p', {}, 'No products yet.'), link('/app/products/new', 'Add a product', 'btn primary')));
}

function productForm(p, onSave, submitLabel) {
  const f = (name, label, el, hint) => h('div', { class: 'field' }, h('label', { for: name }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
  const input = (name, value, type = 'text', extra = {}) => h('input', { id: name, name, type, value: value ?? '', ...extra });
  const facts = p.facts || {};
  const desc = h('textarea', { id: 'description', name: 'description', rows: 6, maxlength: 5000 });
  desc.value = p.description || '';
  const pricing = h('select', { id: 'pricing_model', name: 'pricing_model' }, ['', 'Free', 'Freemium', 'Paid', 'Free trial', 'Open source'].map((o) => h('option', { value: o }, o || 'Choose…')));
  pricing.value = facts.pricing_model || '';
  const form = h('form', { class: 'card', novalidate: true },
    f('url', 'Website', input('url', p.url, 'url', { required: true, readonly: p.id ? true : null })),
    h('div', { class: 'grid2' },
      f('name', 'Product name', input('name', p.name, 'text', { maxlength: 80, required: true })),
      f('tagline', 'Tagline', input('tagline', p.tagline, 'text', { maxlength: 120 }), 'One line. Most forms cut at 60 characters.')),
    f('description', 'Description', desc, 'Plain text, a few sentences. A 160-character version is made for you.'),
    h('div', { class: 'grid2' },
      f('categories', 'Categories', input('categories', (p.categories || []).join(', '), 'text', { placeholder: 'productivity, saas, ai' }), 'Comma separated. Used to match destinations.'),
      f('contact_email', 'Contact email', input('contact_email', p.contact_email, 'email'), 'Shown on listings that ask for one.')),
    h('div', { class: 'grid3' },
      f('pricing_model', 'Pricing', pricing),
      f('x', 'X / Twitter', input('x', facts.x, 'text', { placeholder: '@handle' })),
      f('github', 'GitHub', input('github', facts.github, 'url', { placeholder: 'https://github.com/…' }))),
    f('founder', 'Founder or maker', input('founder', facts.founder, 'text', { maxlength: 80 })),
    h('div', { id: 'form-msg' }),
    h('button', { class: 'btn primary', type: 'submit' }, submitLabel));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (k) => form.elements[k].value.trim();
    if (!v('url') || !v('name')) return form.querySelector('#form-msg').replaceChildren(h('div', { class: 'notice bad' }, 'Website and product name are required.'));
    const body = {
      url: v('url'),
      name: v('name'),
      tagline: v('tagline') || null,
      description: v('description') || null,
      categories: v('categories').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 20),
      contact_email: v('contact_email') || null,
      facts: Object.fromEntries(['pricing_model', 'x', 'github', 'founder'].map((k) => [k, v(k)]).filter(([, x]) => x)),
    };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await onSave(body);
    } catch (err) {
      form.querySelector('#form-msg').replaceChildren(h('div', { class: 'notice bad' }, err.message));
      btn.disabled = false;
    }
  });
  return form;
}

async function newProduct() {
  const root = h('div', {}, h('div', { class: 'crumbs' }, link('/app/products', '← Products')), pageHead('Add a product', 'Start from your URL. Nothing is sent anywhere until you approve it.'));
  const urlInput = h('input', { type: 'url', placeholder: 'https://your-product.com', id: 'start-url', required: true });
  const msg = h('div');
  const holder = h('div');
  let icon = null;
  const fetchBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Fetch details');
  const start = h('form', { class: 'card stack' }, h('label', { for: 'start-url' }, 'Product URL'), h('div', { class: 'btn-row' }, urlInput, fetchBtn), msg,
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => showForm({ url: urlInput.value.trim() }) }, 'Skip and fill in by hand'));
  const showForm = (draft) => {
    const iconBox = icon ? h('div', { class: 'card product-card stack' }, h('img', { class: 'logo lg', src: icon, alt: '' }), h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'use-icon', checked: true }), 'Use this as the logo')) : null;
    holder.replaceChildren(
      h('div', { class: 'section-title' }, 'Review the details'),
      iconBox,
      productForm(draft, async (body) => {
        const p = await post('/products', body);
        if (icon && document.getElementById('use-icon')?.checked) await post(`/products/${p.id}/logo/from-url`, { url: icon }).catch(() => toast('Logo could not be fetched; upload one on the next page.'));
        go(`/app/products/${p.id}`);
      }, 'Save product'),
    );
    start.hidden = true;
  };
  start.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!/^https?:\/\//.test(url)) return msg.replaceChildren(h('div', { class: 'notice bad' }, 'Enter the full URL, starting with https://'));
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Reading your page…';
    try {
      const facts = await post('/products/extract', { url });
      icon = facts.icon_url;
      showForm({ url, name: facts.name, tagline: facts.tagline, description: facts.description, facts: { x: facts.x, github: facts.github } });
    } catch (err) {
      msg.replaceChildren(h('div', { class: 'notice warn' }, `Could not read that page (${err.message}). Fill in the details by hand.`));
      showForm({ url });
    }
  });
  root.append(start, holder);
  return root;
}

async function productPage(id) {
  const [p, campaigns] = await Promise.all([api(`/products/${id}`), api('/campaigns')]);
  const mine = campaigns.filter((c) => c.product_id === id);
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'sr', id: 'logo-file' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 1_000_000) return toast('Logo must be under 1 MB');
    try {
      await api(`/products/${id}/logo`, { method: 'PUT', body: f, headers: { 'content-type': f.type } });
      toast('Logo updated');
      render();
    } catch (e) {
      toast(e.message);
    }
  });
  const approve = async () => {
    await post(`/products/${id}/approve-facts`);
    toast('Approved');
    render();
  };
  const root = h('div', {},
    h('div', { class: 'crumbs' }, link('/app/products', '← Products')),
    h('div', { class: 'page-head' },
      h('div', { class: 'product-card' }, logoEl(p, 'logo lg'), h('div', { class: 'meta' }, h('h1', {}, p.name || p.url), h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.url))),
      h('div', { class: 'btn-row' }, h('label', { class: 'btn', for: 'logo-file' }, p.logo_path ? 'Change logo' : 'Upload logo'), file,
        p.approved_at ? link(`/app/products/${id}/launch`, 'Launch it', 'btn primary') : null)),
  );
  if (!p.approved_at) {
    root.append(h('div', { class: 'notice warn' }, h('b', {}, 'Review and approve these details. '), 'Every submission uses exactly what you approve here, so check spelling, claims and the description first. ',
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary sm', type: 'button', onclick: approve }, 'Approve details'))));
  } else {
    root.append(h('div', { class: 'notice ok' }, `Approved ${when(p.approved_at)}. Editing anything asks you to approve again.`));
  }
  root.append(
    productForm(p, async (body) => {
      const { url: _u, ...patch } = body;
      await api(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      toast('Saved. Approve the details again to launch.');
      render();
    }, 'Save changes'),
  );
  if (mine.length) {
    const statuses = await Promise.all(mine.map((c) => api(`/campaigns/${c.id}/status`)));
    root.append(h('div', { class: 'section-title' }, 'Campaigns'), campaignList(mine, statuses, [p]));
  }
  return root;
}

// ── Launch planner ──
async function launchPage(id) {
  const p = await api(`/products/${id}`);
  if (!p.approved_at) {
    go(`/app/products/${id}`);
    return h('div');
  }
  const chosen = new Set(['directory', 'product-launch-site']);
  let includeUnknown = false;
  let q = '';
  const selected = new Map();
  let list = [];
  const listEl = h('div', { class: 'list' });
  const countEl = h('b');
  const startBtn = h('button', { class: 'btn primary lg', type: 'button' }, 'Prepare submissions');
  const filters = h('div', { class: 'filters' }, CHANNELS.map(([k, label]) => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(k) });
    cb.addEventListener('change', () => (cb.checked ? chosen.add(k) : chosen.delete(k), load()));
    return h('label', { class: 'chip' }, cb, label);
  }));
  const unknown = h('input', { type: 'checkbox' });
  unknown.addEventListener('change', () => ((includeUnknown = unknown.checked), load()));
  const search = h('input', { type: 'search', placeholder: 'Search destinations' });
  search.addEventListener('input', () => {
    q = search.value.trim().toLowerCase();
    draw();
  });
  const updateCount = () => {
    countEl.textContent = `${selected.size} selected`;
    startBtn.disabled = selected.size === 0;
  };
  const draw = () => {
    const shown = list.filter((d) => !q || `${d.name} ${d.description || ''} ${d.categories.join(' ')}`.toLowerCase().includes(q));
    listEl.replaceChildren(...(shown.length ? shown.map(destRow) : [h('div', { class: 'empty muted' }, 'No destinations match these filters.')]));
    updateCount();
  };
  const destRow = (d) => {
    const cb = h('input', { type: 'checkbox', checked: selected.has(d.slug) });
    cb.addEventListener('change', () => (cb.checked ? selected.set(d.slug, d) : selected.delete(d.slug), updateCount()));
    return h('label', { class: 'dest-row' }, cb, h('img', { class: 'fav', src: `/d/${d.slug}/icon`, alt: '', loading: 'lazy' }),
      h('div', { class: 'd' }, h('b', {}, d.name), h('span', {}, d.description || d.canonical_domain)),
      h('div', { class: 'nums' }, d.fit === 'strong' ? h('span', { class: 'pill green' }, 'Good fit') : d.fit === 'weak' ? h('span', { class: 'pill amber', title: 'Unchecked by default' }, d.reason) : null,
        h('span', { class: 'pill' }, channelName(d.channel)), pricePill(d.fee_status), d.domain_rating != null ? h('span', { class: 'pill' }, `DR ${d.domain_rating}`) : null));
  };
  const load = async () => {
    const pricing = ['source_labeled_free', 'verified_free', ...(includeUnknown ? ['unknown'] : [])];
    list = chosen.size ? await api(`/catalog?product=${id}&channel=${[...chosen].join(',')}&pricing=${pricing.join(',')}`) : [];
    selected.clear();
    for (const d of list) if (d.fit !== 'weak') selected.set(d.slug, d);
    draw();
  };
  const msg = h('div');
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.textContent = 'Preparing…';
    try {
      const plan = await post('/campaigns', { product_id: id, destinations: [...selected.keys()], channels: [...chosen], include_unknown_pricing: includeUnknown });
      if (plan.counts.executable === 0) {
        const dupes = plan.targets.filter((t) => t.blockers.some((b) => b.startsWith('duplicate'))).length;
        throw new Error(dupes ? `Every selected destination already has a submission for this product (${dupes}).` : 'None of the selected destinations can take this product.');
      }
      const req = await post(`/campaigns/${plan.campaign.id}/approval-request`);
      await post(`/campaigns/${plan.campaign.id}/approve`, { scope_hash: req.scope_hash });
      await post(`/campaigns/${plan.campaign.id}/run`);
      go(`/app/campaigns/${plan.campaign.id}`);
    } catch (e) {
      msg.replaceChildren(h('div', { class: 'notice bad' }, e.message));
      startBtn.disabled = false;
      startBtn.textContent = 'Prepare submissions';
    }
  });
  await load();
  return h('div', {},
    h('div', { class: 'crumbs' }, link(`/app/products/${id}`, `← ${p.name}`)),
    pageHead(`Launch ${p.name}`, 'Choose where to submit. Free listings only, and anywhere this product was already submitted is left out.'),
    filters,
    h('div', { class: 'filters' }, h('label', { class: 'chip' }, unknown, 'Include unknown pricing'), search,
      h('button', { class: 'btn sm', type: 'button', onclick: () => (list.forEach((d) => selected.set(d.slug, d)), draw()) }, 'Select all'),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => (selected.clear(), draw()) }, 'Clear')),
    msg,
    listEl,
    h('div', { class: 'sticky-bar' }, h('div', {}, countEl, h('div', { class: 'small muted' }, 'You approve this exact list by starting. Listing fees: $0.')), startBtn));
}

// ── Campaigns ──
async function campaignsPage() {
  const [campaigns, products] = await Promise.all([api('/campaigns'), api('/products')]);
  if (!campaigns.length) return h('div', {}, pageHead('Campaigns'), h('div', { class: 'card empty' }, h('p', {}, 'No campaigns yet. Open a product and press Launch it.'), link('/app/products', 'Go to products', 'btn')));
  const statuses = await Promise.all(campaigns.map((c) => api(`/campaigns/${c.id}/status`)));
  return h('div', {}, pageHead('Campaigns'), campaignList(campaigns, statuses, products));
}

async function campaignPage(id) {
  const [status, items, products] = await Promise.all([api(`/campaigns/${id}/status`), api(`/campaigns/${id}/queue`), api('/products')]);
  const c = status.campaign;
  const p = products.find((x) => x.id === c.product_id) || { name: 'Product' };
  const groups = {
    todo: (i) => i.state === 'needs_human' || i.state === 'queued' || i.state === 'executing' || i.state === 'uncertain',
    submitted: (i) => ['submitted', 'scheduled', 'under_review'].includes(i.state),
    live: (i) => i.state === 'published_verified',
    closed: (i) => ['failed', 'rejected', 'canceled', 'removal_observed'].includes(i.state),
  };
  let tab = items.some(groups.todo) ? 'todo' : 'submitted';
  let open = null;
  const listEl = h('div', { class: 'list' });
  const tabs = h('div', { class: 'tabs' });
  const counts = () => Object.fromEntries(Object.entries(groups).map(([k, f]) => [k, items.filter(f).length]));
  const drawTabs = () => {
    const n = counts();
    tabs.replaceChildren(...[['todo', 'To do'], ['submitted', 'Submitted'], ['live', 'Live'], ['closed', 'Skipped']].map(([k, label]) =>
      h('button', { type: 'button', 'aria-selected': String(tab === k), onclick: () => ((tab = k), (open = null), draw()) }, `${label} ${n[k]}`)));
  };
  const progress = h('div', { class: 'progress' });
  const drawProgress = () => {
    const n = counts();
    progress.dataset.total = items.length;
    progress.replaceChildren(h('i', { class: 'live', 'data-w': n.live }), h('i', { class: 'sub', 'data-w': n.submitted }), h('i', { class: 'skip', 'data-w': n.closed }));
    sizeBars(progress);
  };
  const draw = () => {
    drawTabs();
    drawProgress();
    const shown = items.filter(groups[tab]);
    listEl.replaceChildren(...(shown.length ? shown.map(row) : [h('div', { class: 'empty muted' }, tab === 'todo' ? 'Nothing left to do here. Nice.' : 'Nothing here yet.')]));
    if (open) {
      const el = listEl.querySelector(`[data-id="${open}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  };
  const next = (afterId) => {
    const shown = items.filter(groups.todo);
    const idx = shown.findIndex((x) => x.id === afterId);
    open = shown[idx + 1]?.id || shown[0]?.id || null;
  };
  const mark = async (item, action, extra = {}) => {
    const r = await post(`/submissions/${item.id}/mark`, { action, ...extra });
    item.state = r.state;
    if (extra.listing_url) item.listing_url = extra.listing_url;
    toast({ submitted: 'Marked submitted', live: 'Marked live', skipped: 'Skipped', rejected: 'Marked rejected' }[action]);
    if (action === 'submitted' || action === 'skipped') next(item.id);
    else open = null;
    draw();
  };
  const row = (i) => {
    const el = h('div', { class: `item${open === i.id ? ' open' : ''}`, 'data-id': i.id },
      h('img', { class: 'fav', src: `/d/${i.destination}/icon`, alt: '', loading: 'lazy' }),
      h('div', {}, h('div', { class: 'title' }, i.name),
        h('div', { class: 'sub' }, h('span', {}, channelName(i.channel)), i.domain_rating != null ? h('span', {}, `DR ${i.domain_rating}`) : null, i.monthly_traffic ? h('span', {}, `${fmt(i.monthly_traffic)} visits/mo`) : null,
          i.fit === 'strong' ? h('span', { class: 'pill green' }, 'Good fit') : i.fit === 'weak' ? h('span', { class: 'pill amber' }, i.fit_reason) : null,
          i.mode === 'auto' ? h('span', { class: 'pill blue' }, 'automatic') : null, i.listing_url ? h('a', { href: i.listing_url, target: '_blank', rel: 'noopener noreferrer' }, 'listing') : null)),
      h('div', { class: 'btn-row' }, pill(i.state, i.reason_code), h('button', { class: 'btn sm', type: 'button', onclick: () => ((open = open === i.id ? null : i.id), draw()) }, open === i.id ? 'Close' : 'Open')));
    if (open === i.id) el.append(kitPanel(i));
    return el;
  };
  const kitPanel = (i) => {
    const box = h('div', { class: 'kit' }, h('div', { class: 'muted small' }, 'Loading…'));
    api(`/submissions/${i.id}/kit`).then((kit) => {
      const d = kit.destination;
      const urlInput = h('input', { type: 'url', placeholder: 'Listing or confirmation URL (optional)' });
      const facts = h('div', { class: 'facts' }, pricePill(d.pricing), d.link_type ? h('span', { class: 'pill' }, `${d.link_type} link`) : null, d.audience ? h('span', { class: 'pill', title: d.audience }, 'Audience') : null);
      const actions = h('div', { class: 'actions' });
      if (i.state === 'needs_human' && i.mode !== 'auto') {
        actions.append(urlInput,
          h('button', { class: 'btn primary', type: 'button', onclick: () => mark(i, 'submitted', { listing_url: urlInput.value.trim() || null }) }, 'Mark submitted'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => {
            const why = prompt('Why skip it? (optional, e.g. "only paid listings")');
            if (why !== null) mark(i, 'skipped', { note: why || null });
          } }, 'Skip'));
      } else if (['submitted', 'scheduled', 'under_review'].includes(i.state)) {
        urlInput.placeholder = 'Public listing URL';
        if (i.listing_url) urlInput.value = i.listing_url;
        actions.append(urlInput,
          h('button', { class: 'btn primary', type: 'button', onclick: () => (urlInput.value.trim() ? mark(i, 'live', { listing_url: urlInput.value.trim() }) : toast('Paste the public listing URL first')) }, 'Mark live'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => mark(i, 'rejected') }, 'They rejected it'));
      } else if (i.state === 'needs_human') {
        actions.append(h('span', { class: 'muted small' }, `Waiting on: ${i.reason_code}`));
      }
      box.replaceChildren(
        d.eligibility ? h('div', { class: 'notice info small' }, h('b', {}, 'Who they accept: '), d.eligibility) : null,
        d.pricing_note ? h('div', { class: 'notice warn small' }, h('b', {}, 'Pricing: '), d.pricing_note) : null,
        facts,
        h('ol', {}, kit.steps.map((s) => h('li', {}, s))),
        d.submit_url ? h('div', { class: 'btn-row' }, h('a', { class: 'btn primary', href: d.submit_url, target: '_blank', rel: 'noopener noreferrer' }, `Open ${d.name} ↗`),
          h('button', { class: 'btn', type: 'button', onclick: () => copy(kit.fields.map((f) => `${f.label}: ${f.value}`).join('\n\n'), 'All fields copied') }, 'Copy all fields')) : null,
        h('div', {}, kit.fields.map((f) => h('div', { class: 'field-row' }, h('div', { class: 'k' }, f.label, f.max ? h('span', { class: 'muted' }, ` (≤${f.max})`) : null), h('div', { class: 'v' }, f.value),
          h('button', { class: 'btn sm', type: 'button', onclick: () => copy(f.value, `${f.label} copied`) }, 'Copy')))),
        actions);
    }).catch((e) => box.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
    return box;
  };
  const exportBtn = (fmtName, label) => h('button', { class: 'btn sm', type: 'button', onclick: async () => {
    const text = await api(`/reports/${id}?format=${fmtName}`);
    const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text, null, 2)], { type: 'text/plain' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `submitfleet-${id}.${fmtName === 'markdown' ? 'md' : fmtName}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } }, label);
  open = items.find(groups.todo)?.id || null;
  draw();
  return h('div', {},
    h('div', { class: 'crumbs' }, link('/app/campaigns', '← Campaigns')),
    pageHead(`${p.name} launch`, `${items.length} destinations · started ${when(c.created_at)}`,
      h('button', { class: 'btn sm', type: 'button', onclick: async () => copy(await api(`/reports/${id}?format=markdown`), 'Report copied as Markdown') }, 'Copy Markdown'),
      exportBtn('csv', 'CSV'), exportBtn('json', 'JSON')),
    progress, h('div', { class: 'section-title' }), tabs, listEl);
}

// ── Destinations ──
async function destinationsPage() {
  const stats = await api('/catalog-stats');
  const chosen = new Set();
  let q = '';
  const listEl = h('div', { class: 'list' });
  const load = async () => {
    const qs = new URLSearchParams({ limit: '500' });
    if (chosen.size) qs.set('channel', [...chosen].join(','));
    if (q) qs.set('q', q);
    const ds = await api(`/catalog?${qs}`);
    listEl.replaceChildren(...(ds.length ? ds.map((d) => h('div', { class: 'dest-row' }, h('span'),
      h('img', { class: 'fav', src: `/d/${d.slug}/icon`, alt: '', loading: 'lazy' }),
      h('div', { class: 'd' }, h('b', {}, h('a', { href: d.website_url || `https://${d.canonical_domain}`, target: '_blank', rel: 'noopener noreferrer' }, d.name)), h('span', {}, d.description || d.canonical_domain)),
      h('div', { class: 'nums' }, h('span', { class: 'pill' }, channelName(d.channel)), pricePill(d.fee_status), d.domain_rating != null ? h('span', { class: 'pill' }, `DR ${d.domain_rating}`) : null))) : [h('div', { class: 'empty muted' }, 'Nothing matches.')]));
  };
  const search = h('input', { type: 'search', placeholder: 'Search by name, topic or category' });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => ((q = search.value.trim()), load()), 250);
  });
  await load();
  return h('div', {}, pageHead('Destinations', `${stats.total} launch sites and directories · ${stats.free} free to list · ${stats.automated} submit automatically`),
    h('div', { class: 'filters' }, CHANNELS.map(([k, label]) => {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => (cb.checked ? chosen.add(k) : chosen.delete(k), load()));
      return h('label', { class: 'chip' }, cb, `${label} ${stats.by_channel[k] ?? 0}`);
    })), h('div', { class: 'filters' }, search), listEl);
}

// ── Settings ──
async function settingsPage() {
  me = await api('/api/me');
  const keys = await api('/keys');
  const root = h('div', {}, pageHead('Settings', me.user?.email));

  // Passkeys
  const pkList = h('div', { class: 'list' }, me.passkeys.length ? me.passkeys.map((k) => h('div', { class: 'item' }, h('span', {}, '🔑'),
    h('div', {}, h('div', { class: 'title' }, k.name || 'Passkey'), h('div', { class: 'sub' }, h('span', {}, `added ${when(k.created_at)}`), k.last_used_at ? h('span', {}, `· last used ${when(k.last_used_at)}`) : null)),
    h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
      if (!confirm('Remove this passkey?')) return;
      await api(`/api/account/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      render();
    } }, 'Remove'))) : [h('div', { class: 'item' }, h('span'), h('div', { class: 'muted' }, 'No passkeys yet.'), h('span'))]);
  const addPk = h('button', { class: 'btn primary', type: 'button', disabled: !passkeysSupported() }, 'Add a passkey');
  addPk.addEventListener('click', async () => {
    try {
      const { challenge_id, options } = await post('/api/account/passkeys/options');
      const response = await createPasskey(options);
      const name = /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Apple device' : /Android/.test(navigator.userAgent) ? 'Android device' : /Windows/.test(navigator.userAgent) ? 'Windows device' : 'Passkey';
      await post('/api/account/passkeys', { challenge_id, response, name });
      toast('Passkey added');
      render();
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast(e.message);
    }
  });
  root.append(h('div', { class: 'section-title' }, 'Passkeys'), h('p', { class: 'muted' }, 'Sign in with your fingerprint, face or device PIN. No password to remember.'), pkList, h('div', { class: 'btn-row' }, addPk));

  // Password
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, placeholder: 'At least 10 characters' });
  root.append(h('div', { class: 'section-title' }, me.has_password ? 'Change password' : 'Add a password'),
    h('div', { class: 'card' }, h('p', { class: 'muted small' }, 'Optional. Useful on devices without passkeys. You can always sign in with an emailed link.'),
      h('div', { class: 'btn-row' }, pw, h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          await post('/api/account/password', { password: pw.value });
          pw.value = '';
          toast('Password saved');
        } catch (e) {
          toast(e.message);
        }
      } }, 'Save'))));

  // API keys
  const label = h('input', { type: 'text', placeholder: 'What is it for? e.g. Claude Code', maxlength: 80 });
  const role = h('select', {}, h('option', { value: 'agent' }, 'Agent: can plan and ask'), h('option', { value: 'owner' }, 'Owner: full access'));
  const shown = h('div');
  root.append(h('div', { class: 'section-title' }, 'API keys'),
    h('p', { class: 'muted' }, 'For agents, scripts and the MCP server. Agent keys can plan campaigns and request approval; only you approve.'),
    shown,
    h('div', { class: 'list' }, keys.length ? keys.map((k) => h('div', { class: 'item' }, h('span', { class: 'pill' }, k.role),
      h('div', {}, h('div', { class: 'title' }, k.label), h('div', { class: 'sub' }, h('span', {}, `created ${when(k.created_at)}`), h('span', {}, k.last_used_at ? `· used ${when(k.last_used_at)}` : '· never used'))),
      h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
        if (!confirm('Revoke this key? Anything using it stops working.')) return;
        await api(`/keys/${k.id}`, { method: 'DELETE' });
        render();
      } }, 'Revoke'))) : [h('div', { class: 'item' }, h('span'), h('div', { class: 'muted' }, 'No keys.'), h('span'))]),
    h('div', { class: 'btn-row' }, label, role, h('button', { class: 'btn', type: 'button', onclick: async () => {
      const k = await post('/keys', { role: role.value, label: label.value.trim() || 'API key' });
      shown.replaceChildren(h('div', { class: 'notice ok' }, h('b', {}, 'Copy this key now. It is not shown again.'), h('div', { class: 'token' }, k.token),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => copy(k.token, 'Key copied') }, 'Copy key'))));
      label.value = '';
    } }, 'Create key')));

  // CLI + MCP
  const origin = location.origin;
  root.append(h('div', { class: 'section-title' }, 'CLI and MCP'),
    h('div', { class: 'card stack' },
      h('p', {}, 'Install the CLI and sign in from your terminal:'),
      h('pre', {}, h('code', {}, `curl -fsSL ${origin}/install.sh | sh\nsubmitfleet login`)),
      h('p', {}, 'Connect an MCP client (Claude Code, Cursor, …) with an agent key:'),
      h('pre', {}, h('code', {}, `claude mcp add --transport http submitfleet ${origin}/mcp --header "Authorization: Bearer <agent key>"`))));

  root.append(h('div', { class: 'section-title' }, 'Session'), h('button', { class: 'btn', type: 'button', onclick: signOut }, 'Sign out'));
  return root;
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
  location.assign('/');
}

$('#pause-all').addEventListener('click', async () => {
  if (!confirm('Stop every automated submission now? Assisted work is not affected.')) return;
  await post('/pause');
  toast('Automated submissions paused');
});

api('/api/me').then((m) => {
  me = m;
  $('#who').textContent = m.user?.email || '';
}).catch(() => {});
render();
