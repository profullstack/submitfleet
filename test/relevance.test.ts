import { describe, expect, it } from 'vitest';
import type { Destination } from '../src/catalog.js';
import type { Product } from '../src/products.js';
import { relevance } from '../src/relevance.js';

const p = (over: Partial<Product>): Product => ({ id: 'p', workspace_id: 'w', canonical_key: 'x', url: 'https://x.example', name: 'X', tagline: null, description: null, categories: [], contact_email: null, logo_path: null, facts: {}, destination_fields: {}, approved_at: 'x', approved_by: 'o', created_at: 'x', updated_at: 'x', ...over });
const d = (categories: string[], eligibility = '', name = 'Dir'): Destination => ({ categories, eligibility, name } as Destination);
const iptv = p({ name: 'hdtilt', tagline: 'open-source IPTV player', description: 'A free IPTV player for your own playlist with a TV guide.' });
const aiTool = p({ name: 'Summly', tagline: 'AI meeting notes', description: 'Uses an LLM to summarise calls.' });

describe('relevance', () => {
  it('AI-only directories are a weak fit for a non-AI product and strong for an AI one', () => {
    expect(relevance(iptv, d(['ai']))).toMatchObject({ fit: 'weak', reason: 'AI tools only' });
    expect(relevance(aiTool, d(['ai'])).fit).toBe('strong');
    expect(relevance(p({ categories: ['ai'] }), d(['ai'])).fit).toBe('strong');
  });
  it('general directories fit anyone; mixed niche + general stays general', () => {
    expect(relevance(iptv, d(['business', 'saas'])).fit).toBe('general');
    expect(relevance(iptv, d(['ai', 'saas'])).fit).toBe('general');
    expect(relevance(iptv, d([])).fit).toBe('general');
  });
  it('platform-only listings need the platform', () => {
    const stripe = d(['business', 'saas'], 'Requires an activated Stripe account that is not on the restricted list.', 'Stripe');
    expect(relevance(iptv, stripe)).toMatchObject({ fit: 'weak', reason: 'Stripe apps only' });
    expect(relevance(p({ description: 'Billing analytics for Stripe users.' }), stripe).fit).not.toBe('weak');
  });
});
