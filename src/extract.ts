import { lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { isIP } from 'node:net';
import { SubmitFleetError } from './util.js';

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SubmitFleetError('invalid_url_scheme', 'only http(s) URLs can be read');
  if (url.port && !['80', '443'].includes(url.port)) throw new SubmitFleetError('url_not_public', 'non-standard ports are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new SubmitFleetError('url_unresolvable', `cannot resolve ${host}`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new SubmitFleetError('url_not_public', 'that address is not on the public internet');
}

// The connection itself re-checks every resolved address, so a name that resolves
// publicly for the pre-check and privately at connect time (DNS rebinding) still fails.
const guardedAgent = new Agent({
  connect: {
    lookup: (host, opts, cb) =>
      dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
        if (err) return cb(err, '', 4);
        const list = addrs as unknown as { address: string; family: number }[];
        if (list.some((a) => isPrivateAddress(a.address))) return cb(new Error('url_not_public'), '', 4);
        if ((opts as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      }),
  },
});

/** fetch() whose connections go through the address-checking agent. */
export const guardedFetch = ((input: string | URL, init?: RequestInit) =>
  undiciFetch(input, { ...(init as object), dispatcher: guardedAgent } as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch;

/** Fetches a public page with SSRF guards: DNS checked at every hop, no private ranges, bounded size and time. */
export async function fetchPublic(raw: string, f: typeof fetch = guardedFetch, accept = 'text/html'): Promise<{ url: string; body: Buffer; type: string }> {
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept, 'user-agent': 'SubmitFleet/0.3 (+https://submitfleet.com)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new SubmitFleetError('fetch_failed', `HTTP ${res.status}`);
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { url: url.toString(), body: Buffer.concat(chunks), type: res.headers.get('content-type') ?? '' };
  }
  throw new SubmitFleetError('fetch_failed', 'too many redirects');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '').trim() : null;
}

export interface ProposedFacts {
  url: string;
  name: string | null;
  tagline: string | null;
  description: string | null;
  icon_url: string | null;
  /** Every icon worth trying, most useful first. */
  icon_candidates: string[];
  x: string | null;
  github: string | null;
}

/** Reads what a page says about itself. Every value is a proposal for the owner to edit and approve. */
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function clean(x: string | null | undefined): string | null {
  if (!x) return null;
  const t = decodeEntities(x).replace(/\s+/g, ' ').trim().replace(/[\s.:|·\-–—]+$/, '').replace(/^[\s|·\-–—:]+/, '');
  return t || null;
}

export function parseFacts(html: string, pageUrl: string): ProposedFacts {
  const head = html.slice(0, 300_000);
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  const meta = (key: string) => {
    for (const m of metas) {
      const k = (attr(m, 'property') ?? attr(m, 'name') ?? '').toLowerCase();
      if (k === key) return attr(m, 'content');
    }
    return null;
  };
  const title = (() => {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    return m ? decodeEntities(m[1]!.replace(/\s+/g, ' ')).trim() : null;
  })();
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const label = norm(host.split('.')[0]!);
  const siteName = clean(meta('og:site_name') ?? meta('application-name'));
  const titleText = clean(meta('og:title') ?? meta('twitter:title') ?? title);
  // "Name | tagline", "Name - tagline", "Name: tagline", "tagline · Name"
  const parts = (titleText ?? '').split(/\s+[|\-–—·]\s+|:\s+/).map(clean).filter((x): x is string => !!x);
  const matchesDomain = (x: string) => {
    const n = norm(x);
    return !!n && (n === label || n.includes(label) || label.includes(n));
  };
  // A declared site name wins when it is the product's name; a four-word "site name" that does
  // not match the domain is a slogan ("Know before it drops"), not a name.
  const brandLike = (x: string | null) => !!x && x.length <= 40 && (matchesDomain(x) || x.split(/\s+/).length <= 3);
  let name: string | null =
    (siteName && matchesDomain(siteName) ? siteName : null) ??
    parts.find(matchesDomain) ??
    (brandLike(siteName) ? siteName : null) ??
    (parts.length === 1 && brandLike(parts[0]!) ? parts[0]! : null) ??
    host.split('.')[0]!;
  name = clean(name);
  const description = clean(meta('og:description') ?? meta('description') ?? meta('twitter:description'));
  let tagline: string | null = parts.filter((x) => norm(x) !== norm(name ?? '') && !matchesDomain(x)).join(' - ') || null;
  if (tagline && name) tagline = clean(tagline.replace(new RegExp(`^${escapeRe(name)}\\s*[:|\\-–—·]\\s*`, 'i'), ''));
  if (!tagline && description) {
    const first = description.split(/(?<=[.!?])\s/)[0]!;
    if (first.length <= 90) tagline = clean(first.replace(/[.]$/, ''));
  }
  if (tagline && name && norm(tagline) === norm(name)) tagline = null;
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const icons: string[] = [];
  const addIcon = (href: string | null) => {
    if (!href) return;
    try {
      const u = new URL(href, pageUrl).toString();
      if (!icons.includes(u)) icons.push(u);
    } catch {
      /* ignore malformed href */
    }
  };
  // Raster icons first (directories want PNG/JPEG), biggest declared size first.
  const iconLinks = links
    .map((l) => ({ rel: (attr(l, 'rel') ?? '').toLowerCase(), href: attr(l, 'href'), type: (attr(l, 'type') ?? '').toLowerCase(), size: Number((attr(l, 'sizes') ?? '').split('x')[0]) || 0 }))
    .filter((l) => /(^|\s)(apple-touch-icon|icon)(\s|$)/.test(l.rel) && l.href);
  const raster = (l: { href: string | null; type: string }) => !/\.svg(\?|$)|\.ico(\?|$)/i.test(l.href ?? '') && !/svg|icon$/.test(l.type);
  for (const l of iconLinks.filter(raster).sort((a, b) => (b.rel.includes('apple') ? 1 : 0) - (a.rel.includes('apple') ? 1 : 0) || b.size - a.size)) addIcon(l.href);
  for (const conventional of ['/apple-touch-icon.png', '/icon-512.png', '/icon-192.png', '/logo.png', '/favicon.png']) addIcon(conventional);
  for (const l of iconLinks.filter((l) => !raster(l))) addIcon(l.href);
  const icon = icons[0] ?? null;
  const anchors = head.match(/href\s*=\s*["']([^"']+)["']/gi) ?? [];
  const find = (re: RegExp) => {
    for (const a of anchors) {
      const m = re.exec(a);
      if (m) return m[1]!;
    }
    return null;
  };
  const xHandle = meta('twitter:site') ?? meta('twitter:creator') ?? (find(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:["'/?])/i) ? `@${find(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:["'/?])/i)}` : null);
  const gh = find(/(https?:\/\/github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)/i);
  return {
    url: pageUrl,
    name: name ? name.slice(0, 80) : null,
    tagline: tagline ? tagline.slice(0, 120) : null,
    description: description ? description.slice(0, 2000) : null,
    icon_url: icon,
    icon_candidates: icons,
    x: xHandle && /^@?[A-Za-z0-9_]{1,15}$/.test(xHandle) ? (xHandle.startsWith('@') ? xHandle : `@${xHandle}`) : null,
    github: gh,
  };
}

export async function extractFacts(url: string, f: typeof fetch = guardedFetch): Promise<ProposedFacts> {
  const page = await fetchPublic(url, f);
  return parseFacts(page.body.toString('utf8'), page.url);
}
