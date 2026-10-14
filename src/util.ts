import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

/** JSON with sorted keys, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashValue(v: unknown): string {
  return sha256(canonicalJson(v));
}

/**
 * Canonical product identity: lower-cased host without www, path without trailing
 * slash, no query or fragment. Tracking parameters must never create a new product.
 */
export function canonicalProductKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new SubmitFleetError('invalid_request', 'url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SubmitFleetError('invalid_url_scheme', 'url must be http(s)');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

// ── Secret sealing ────────────────────────────────────────────────────────────
// AES-256-GCM with a key from SUBMITFLEET_SECRET_KEY (32 bytes, base64 or hex).
// Sealed blobs live in the accounts table; plaintext never reaches logs, reports
// or model context.

export function loadSecretKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('secret_key_missing: set SUBMITFLEET_SECRET_KEY (32 bytes, base64 or hex)');
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('secret_key_invalid: expected 32 bytes');
  return buf;
}

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function unseal(key: Buffer, sealed: string): string {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('sealed_secret_invalid');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
}

/** Removes anything that looks like a credential before a value is logged or reported. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|secret|password|cookie|otp|code|authorization|api[_-]?key/i.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  if (typeof value === 'string' && /^(Bearer\s+)?eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return '[redacted]';
  return value;
}

export class SubmitFleetError extends Error {
  constructor(
    public code: string,
    message?: string,
    public detail?: unknown,
  ) {
    super(message ?? code);
  }
}
