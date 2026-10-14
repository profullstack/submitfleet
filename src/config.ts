import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SubmitFleetConfig } from './service.js';

export function dataDir(): string {
  return process.env.SUBMITFLEET_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'submitfleet');
}

/**
 * Hosted mode reads SUBMITFLEET_SECRET_KEY from the environment the vault injects.
 * Self-hosted local mode generates a key file (0600) on first use.
 */
export function resolveSecretKey(create: boolean): string | undefined {
  if (process.env.SUBMITFLEET_SECRET_KEY) return process.env.SUBMITFLEET_SECRET_KEY;
  const file = join(dataDir(), 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  if (!create) return undefined;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('base64');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export function loadConfig(opts: { createSecret?: boolean } = {}): SubmitFleetConfig {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const assetsDir = process.env.SUBMITFLEET_ASSETS_DIR ?? join(dir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  return {
    dbUrl: process.env.SUBMITFLEET_DB_URL ?? `file:${join(dir, 'submitfleet.db')}`,
    dbAuthToken: process.env.SUBMITFLEET_DB_AUTH_TOKEN,
    secretKey: resolveSecretKey(opts.createSecret ?? true),
    assetsDir,
  };
}

export const PUBLIC_ORIGIN = process.env.SUBMITFLEET_PUBLIC_ORIGIN ?? 'https://submitfleet.com';
