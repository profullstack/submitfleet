import type { Destination } from './catalog.js';
import type { Product } from './products.js';

export interface KitField {
  key: string;
  label: string;
  value: string;
  /** Character limit the value already fits, when one is conventional. */
  max?: number;
}

export interface SubmissionKit {
  destination: {
    slug: string;
    name: string;
    submit_url: string | null;
    website_url: string | null;
    channel: string | null;
    pricing: string;
    pricing_note: string | null;
    eligibility: string | null;
    audience: string | null;
    link_type: string | null;
    domain_rating: number | null;
    monthly_traffic: number | null;
  };
  fields: KitField[];
  steps: string[];
}

/** Cut at a sentence or word boundary so a pasted value never ends mid-word. */
export function fit(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(' ');
  return `${cut.slice(0, word > 0 ? word : max - 1).replace(/[,;:]$/, '')}…`;
}

const FACT_LABELS: Record<string, string> = {
  pricing_model: 'Pricing',
  launch_date: 'Launch date',
  x: 'X / Twitter',
  github: 'GitHub',
  linkedin: 'LinkedIn',
  founder: 'Founder / maker',
  company: 'Company',
  location: 'Location',
};

/**
 * Everything a directory form usually asks for, built only from the owner-approved
 * product facts. Nothing is invented: a fact that is missing is simply absent.
 */
export function buildKit(product: Product, d: Destination, logoUrl: string | null): SubmissionKit {
  const fields: KitField[] = [];
  const add = (key: string, label: string, value: string | null | undefined, max?: number) => {
    if (value && value.trim()) fields.push({ key, label, value: max ? fit(value, max) : value.trim(), max });
  };
  add('name', 'Product name', product.name);
  add('url', 'Website', product.url);
  add('tagline', 'Tagline', product.tagline, 60);
  add('short_description', 'Short description', product.description ?? product.tagline, 160);
  add('description', 'Full description', product.description);
  if (product.categories.length) add('categories', 'Categories / tags', product.categories.join(', '));
  add('email', 'Contact email', product.contact_email);
  add('logo', 'Logo URL', logoUrl);
  for (const [k, v] of Object.entries(product.facts)) {
    if (typeof v === 'string' || typeof v === 'number') add(`fact.${k}`, FACT_LABELS[k] ?? k.replace(/_/g, ' '), String(v));
  }
  const steps = [
    `Open ${d.submission_url ?? d.website_url ?? d.canonical_domain}${d.account_requirement !== 'none' && d.account_requirement !== 'unknown' ? ' and sign in' : ''}.`,
    'Copy each field below into the matching box. Leave anything they do not ask for.',
    d.fee_status === 'source_labeled_free'
      ? 'Choose the free option. If the form only offers a paid listing, stop and mark it skipped.'
      : 'If the form asks for payment, stop and mark it skipped.',
    'After you submit, come back and mark it submitted (paste the listing or confirmation URL if you got one).',
  ];
  return {
    destination: {
      slug: d.slug,
      name: d.name,
      submit_url: d.submission_url,
      website_url: d.website_url,
      channel: d.channel,
      pricing: d.fee_status,
      pricing_note: d.fee_conditions,
      eligibility: d.eligibility,
      audience: d.audience,
      link_type: d.link_type,
      domain_rating: d.domain_rating,
      monthly_traffic: d.monthly_traffic,
    },
    fields,
    steps,
  };
}
