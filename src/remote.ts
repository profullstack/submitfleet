import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { SubmitFleetError } from './util.js';

export const CLIENT_ID = 'submitfleet-cli';
export const DEFAULT_URL = 'https://submitfleet.com';

export interface StoredAuth {
  url: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export function authFile(): string {
  return process.env.SUBMITFLEET_AUTH_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'submitfleet', 'auth.json');
}

export function readAuth(): StoredAuth | null {
  try {
    return JSON.parse(readFileSync(authFile(), 'utf8')) as StoredAuth;
  } catch {
    return null;
  }
}

function writeAuth(a: StoredAuth): void {
  const f = authFile();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(a, null, 2), { mode: 0o600 });
  chmodSync(f, 0o600);
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // no browser available; the URL is printed for the user
  }
}

async function tokenRequest(url: string, body: Record<string, string>): Promise<StoredAuth> {
  const res = await fetch(`${url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const j = (await res.json().catch(() => ({}))) as Record<string, string | number>;
  if (!res.ok || !j.access_token) throw new SubmitFleetError(String(j.error ?? 'login_failed'), String(j.error_description ?? `HTTP ${res.status}`));
  return { url, access_token: String(j.access_token), refresh_token: String(j.refresh_token), expires_at: Date.now() + Number(j.expires_in) * 1000 };
}

/** OAuth 2.1 authorization code + PKCE (S256) with a loopback redirect (RFC 8252). */
export async function login(url = DEFAULT_URL, log: (s: string) => void = (s) => process.stderr.write(`${s}\n`), opts: { open?: boolean; timeoutMs?: number } = {}): Promise<StoredAuth> {
  const base = url.replace(/\/+$/, '');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const done = (ok: boolean, msg: string) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>SubmitFleet</title><body style="font-family:system-ui;padding:40px"><h2>${ok ? 'Signed in' : 'Sign-in failed'}</h2><p>${msg}</p></body>`);
      };
      try {
        if (u.searchParams.get('state') !== state) throw new SubmitFleetError('state_mismatch', 'the response did not match this login; run submitfleet login again');
        if (u.searchParams.get('error')) throw new SubmitFleetError('access_denied', 'access was denied in the browser');
        const code = u.searchParams.get('code');
        if (!code) throw new SubmitFleetError('login_failed', 'no code in the response');
        const auth = await tokenRequest(base, { grant_type: 'authorization_code', code, client_id: CLIENT_ID, redirect_uri: redirect, code_verifier: verifier });
        writeAuth(auth);
        done(true, 'You can close this tab and return to the terminal.');
        clearTimeout(timer);
        server.close();
        resolve(auth);
      } catch (e) {
        done(false, e instanceof Error ? e.message : 'unknown error');
        clearTimeout(timer);
        server.close();
        reject(e);
      }
    });
    let redirect = '';
    const timer = setTimeout(() => {
      server.close();
      reject(new SubmitFleetError('login_timeout', 'no response from the browser within 5 minutes'));
    }, opts.timeoutMs ?? 300_000);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      redirect = `http://127.0.0.1:${port}/callback`;
      const authorize = `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state })}`;
      log(`Opening your browser to sign in. If it does not open, visit:\n\n  ${authorize}\n`);
      if (opts.open !== false) openBrowser(authorize);
    });
  });
}

export async function logout(): Promise<boolean> {
  const a = readAuth();
  if (!a) return false;
  await fetch(`${a.url}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.refresh_token }) }).catch(() => {});
  if (existsSync(authFile())) rmSync(authFile());
  return true;
}

/** Access token, refreshed (and rotated) when it is about to expire. */
export async function accessToken(): Promise<StoredAuth> {
  const a = readAuth();
  if (!a) throw new SubmitFleetError('not_logged_in', 'run submitfleet login first');
  if (a.expires_at - Date.now() > 60_000) return a;
  try {
    const next = await tokenRequest(a.url, { grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: CLIENT_ID });
    writeAuth(next);
    return next;
  } catch (e) {
    throw new SubmitFleetError('session_expired', `sign in again with submitfleet login (${e instanceof Error ? e.message : e})`);
  }
}

export async function remote(method: string, path: string, body?: unknown): Promise<unknown> {
  const a = await accessToken();
  const res = await fetch(`${a.url}${path.startsWith('/api') ? path : `/api/v1${path}`}`, {
    method,
    headers: { authorization: `Bearer ${a.access_token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const d = data as { error?: string; message?: string; detail?: unknown };
    throw new SubmitFleetError(d.error ?? `http_${res.status}`, d.message ?? `HTTP ${res.status}`, d.detail);
  }
  return data;
}

/** Bridges a stdio MCP client to the hosted Streamable HTTP endpoint, one JSON-RPC message per line. */
export async function mcpStdioProxy(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const a = await accessToken();
    const res = await fetch(`${a.url}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: line,
    });
    const text = await res.text();
    if (!text.trim()) continue;
    // A JSON response is one message; an SSE stream carries messages on data: lines.
    if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) process.stdout.write(`${text.trim()}\n`);
    else for (const l of text.split('\n')) if (l.startsWith('data:')) process.stdout.write(`${l.slice(5).trim()}\n`);
  }
}
