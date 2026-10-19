/**
 * The pit.world network footer, fetched server side from
 * https://pit.world/snippets/footer.html and injected before </body> on every
 * page. Refetched at most hourly with a 3-second timeout; on failure the last
 * good copy stays, or nothing renders, so pit.world being down never breaks a page.
 */
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=submitfleet.com';
const TTL_MS = 60 * 60 * 1000;

let cached = '';
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

export function refreshPitFooter(): Promise<void> {
  if (Date.now() - fetchedAt < TTL_MS) return Promise.resolve();
  inflight ??= (async () => {
    try {
      const res = await fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const html = await res.text();
        if (html.includes('data-pit-footer')) cached = html;
      }
    } catch {
      // Keep the last good footer.
    } finally {
      fetchedAt = Date.now();
      inflight = null;
    }
  })();
  return inflight;
}

/** Inserts the footer as the last thing in <body>. */
export async function withPitFooter(body: string): Promise<string> {
  await refreshPitFooter();
  if (!cached) return body;
  const i = body.lastIndexOf('</body>');
  return i === -1 ? body : `${body.slice(0, i)}${cached}\n${body.slice(i)}`;
}
