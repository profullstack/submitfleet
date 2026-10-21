/**
 * The crawl door: AI training crawlers, headless browsers and SEO scrapers buy a
 * day pass ($1 a day over x402, or any coin / PayPal through CoinPay's hosted
 * checkout) on /crawl, and get a 402 everywhere else. People, verified search
 * crawlers, AI chat/search fetchers and signed-in users are never charged, and
 * the API, MCP and OAuth endpoints are never metered. Built only with a scoped
 * key and a payee, so a local or self-hosted server never sells.
 */
import { createGateway } from '@profullstack/x402-gateway';
import { SESSION_COOKIE } from './auth.js';

export type CrawlGate = ReturnType<typeof createGateway>;

export function createCrawlGate(env: Record<string, string | undefined> = process.env): CrawlGate | null {
  const apiKey = env.COINPAY_X402_KEY ?? '';
  const payTo = env.CRAWL_PAY_TO ?? '';
  if (!apiKey || !payTo) return null;
  const session = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`);
  return createGateway({
    siteUrl: (env.SUBMITFLEET_PUBLIC_ORIGIN || 'https://submitfleet.com').replace(/\/+$/, ''),
    siteName: 'SubmitFleet',
    coinpay: { apiKey },
    payTo,
    contact: 'mailto:anthony@profullstack.com',
    openPaths: ['/healthz', '/readyz', '/install.sh', '/llms.txt', '/api/', '/mcp', '/oauth/'],
    exempt: (request: Request) => session.test(request.headers.get('cookie') ?? ''),
  });
}
