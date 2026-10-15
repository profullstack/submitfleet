import type { Destination } from './catalog.js';
import type { Product } from './products.js';

export type Fit = 'strong' | 'general' | 'weak';

/** Catalog categories that restrict who a directory accepts, with what marks a product as belonging. */
const NICHES: Record<string, { label: string; re: RegExp }> = {
  ai: { label: 'AI tools only', re: /\b(ai|a\.i\.|artificial intelligence|machine learning|ml|llms?|gpt|chatbot|agents?|genai|generative)\b/i },
  'developer-tools': { label: 'developer tools only', re: /\b(developers?|devtools?|dev tools?|api|sdk|cli|framework|library|ide|code|coding|github|devops|database|open[- ]source (library|framework|tool))\b/i },
  design: { label: 'design resources only', re: /\b(design|designers?|figma|ui kit|icons?|fonts?|illustrations?|mockups?|templates?)\b/i },
  ecommerce: { label: 'e-commerce only', re: /\b(e-?commerce|shop|store|shopify|woocommerce|checkout|merchants?)\b/i },
  marketing: { label: 'marketing tools only', re: /\b(marketing|seo|ads?|advertising|growth|newsletter|email campaigns?|affiliate)\b/i },
  productivity: { label: 'productivity tools only', re: /\b(productivity|to-?do|tasks?|notes?|calendar|workflow|focus|habits?)\b/i },
};
const GENERIC = new Set(['business', 'saas', 'startup', 'indie', 'community', 'tools', 'software']);

/** Directories that only list things built on one platform. */
const PLATFORMS: { re: RegExp; needs: RegExp; label: string }[] = [
  { re: /\bstripe (account|app)\b/i, needs: /\bstripe\b/i, label: 'Stripe apps only' },
  { re: /\bshopify (app|store|merchant)/i, needs: /\bshopify\b/i, label: 'Shopify apps only' },
  { re: /\b(chrome|browser) extensions?\b/i, needs: /\b(chrome|browser) extension\b/i, label: 'browser extensions only' },
  { re: /\bwordpress (plugin|theme)s?\b/i, needs: /\bwordpress\b/i, label: 'WordPress plugins only' },
  { re: /\bnotion templates?\b/i, needs: /\bnotion\b/i, label: 'Notion templates only' },
  { re: /\bfigma (plugin|file|community)/i, needs: /\bfigma\b/i, label: 'Figma resources only' },
  { re: /\b(gpts?|custom gpt)s? store\b/i, needs: /\bgpt\b/i, label: 'GPTs only' },
];

function productText(p: Product): string {
  return [p.name, p.tagline, p.description, p.categories.join(' '), Object.values(p.facts).join(' ')].filter(Boolean).join(' ');
}

export function relevance(p: Product, d: Destination): { fit: Fit; reason: string | null; score: number } {
  const text = productText(p);
  const mine = new Set(p.categories.map((c) => c.toLowerCase()));
  const elig = `${d.eligibility ?? ''} ${d.name}`;
  for (const pl of PLATFORMS) if (pl.re.test(elig) && !pl.needs.test(text)) return { fit: 'weak', reason: pl.label, score: 0 };

  const cats = d.categories.map((c) => c.toLowerCase());
  const niche = cats.filter((c) => NICHES[c]);
  const matched = niche.filter((c) => mine.has(c) || NICHES[c]!.re.test(text));
  const generic = cats.some((c) => GENERIC.has(c)) || cats.length === 0;
  // Launch sites first, then maker-oriented directories, then broad business listings.
  const bonus = (d.channel === 'product-launch-site' ? 1 : 0) + (cats.some((c) => c === 'startup' || c === 'indie') ? 0.5 : 0) + (cats.includes('saas') ? 0.25 : 0);
  if (matched.length) return { fit: 'strong', reason: null, score: 3 + matched.length + bonus };
  if (niche.length && !generic) return { fit: 'weak', reason: NICHES[niche[0]!]!.label, score: 0 };
  return { fit: 'general', reason: null, score: 1 + bonus };
}
