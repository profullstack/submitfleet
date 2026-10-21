import { afterEach, describe, expect, it } from 'vitest';
import { createCrawlGate } from '../src/crawl-gate.js';
import { buildApp } from '../src/http.js';
import { harness, type Harness } from './helpers.js';

process.env.PROFULLSTACK_FOOTER_OFFLINE ??= '1';

const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const CHROME = {
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-dest': 'document',
};

let h: Harness;
afterEach(() => h?.cleanup());

async function app() {
  h = await harness();
  const crawlGate = createCrawlGate({ COINPAY_X402_KEY: 'cp_live_test', CRAWL_PAY_TO: '0xCC3b072391AE7A8d10cF00DdC5F61DB2cA5541E5' });
  return buildApp(h.fleet, { crawlGate });
}

describe('crawl gateway', () => {
  it('is off without a key', () => {
    expect(createCrawlGate({})).toBeNull();
  });
  it('charges GPTBot with a PAYMENT-REQUIRED offer', async () => {
    const res = await (await app()).request('/', { headers: { 'user-agent': GPT } });
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
  });
  it('sells a $1 day pass on /crawl', async () => {
    const res = await (await app()).request('/crawl', { headers: { accept: 'application/json' } });
    expect(res.status).toBe(402);
    expect(String(((await res.json()) as { accepts: Array<{ amount: string }> }).accepts[0]!.amount)).toBe('1000000');
  });
  it('lets a browser, the API and the health check through', async () => {
    const a = await app();
    expect((await a.request('/', { headers: CHROME })).status).not.toBe(402);
    expect((await a.request('/healthz', { headers: { 'user-agent': GPT } })).status).toBe(200);
    expect((await a.request('/api/v1/products', { headers: { 'user-agent': GPT } })).status).toBe(401);
  });
});
