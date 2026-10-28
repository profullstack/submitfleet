/**
 * Customer webhooks: a workspace subscribes HTTPS endpoints to campaign and
 * submission events and gets signed CloudEvents (Standard Webhooks headers).
 * Delivery, retries, the outbox and the /api/v1/webhooks API come from
 * @profullstack/webhooks; this file names the events and wires the store.
 */
import { Webhooks, type GuardOptions, type SecretBox } from '@profullstack/webhooks';
import type { Db } from './db.js';
import { seal, unseal } from './util.js';
import { libsqlWebhookStore } from './webhook-store.js';

/** Every event SubmitFleet emits. The owner of each is the campaign's workspace. */
export const WEBHOOK_EVENTS = [
  'campaign.started',
  'campaign.paused',
  'campaign.resumed',
  'campaign.canceled',
  'campaign.completed',
  'submission.needs_human',
  'submission.submitted',
  'submission.published',
  'submission.rejected',
  'submission.failed',
  'submission.removed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Intent state -> the event a move into it emits (states not listed emit nothing). */
export const SUBMISSION_EVENT: Record<string, WebhookEvent> = {
  needs_human: 'submission.needs_human',
  submitted: 'submission.submitted',
  scheduled: 'submission.submitted',
  published_verified: 'submission.published',
  rejected: 'submission.rejected',
  failed: 'submission.failed',
  removal_observed: 'submission.removed',
};

export interface WebhooksConfig {
  /** CloudEvents `source`: the site's public origin. */
  source: string;
  /** SUBMITFLEET_SECRET_KEY: seals endpoint secrets at rest (AES-256-GCM) when set. */
  secretKey: Buffer | null;
  fetch?: typeof fetch;
  guard?: GuardOptions;
  now?: () => number;
}

/** Seals with the app key; reads a secret stored before a key was configured as it is. */
export function secretBox(key: Buffer): SecretBox {
  return {
    seal: (s) => seal(key, s),
    open: (s) => (s.startsWith('v1.') ? unseal(key, s) : s),
  };
}

export function createWebhooks(db: Db, cfg: WebhooksConfig): Webhooks {
  return new Webhooks({
    store: libsqlWebhookStore(db),
    source: cfg.source,
    eventTypes: [...WEBHOOK_EVENTS],
    secretBox: cfg.secretKey ? secretBox(cfg.secretKey) : undefined,
    fetchImpl: cfg.fetch,
    guard: cfg.guard,
    now: cfg.now,
    log: (m) => console.error(`[webhooks] ${m}`),
  });
}
