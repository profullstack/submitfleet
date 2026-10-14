import { SubmitFleetError } from './util.js';

export const INTENT_STATES = [
  'queued',
  'executing',
  'submitted',
  'scheduled',
  'needs_human',
  'uncertain',
  'failed',
  'under_review',
  'published_verified',
  'rejected',
  'removal_observed',
  'canceled',
] as const;

export type IntentState = (typeof INTENT_STATES)[number];

// draft -> validated -> awaiting_approval -> approved live on the campaign; an
// intent row only exists once an approved campaign queues it.
const TRANSITIONS: Record<IntentState, IntentState[]> = {
  queued: ['executing', 'canceled'],
  executing: ['submitted', 'scheduled', 'needs_human', 'uncertain', 'failed', 'queued'],
  // queued again only after reconciliation proves no remote write happened
  uncertain: ['submitted', 'scheduled', 'queued', 'needs_human', 'failed'],
  needs_human: ['queued', 'submitted', 'scheduled', 'failed', 'canceled'],
  submitted: ['under_review', 'published_verified', 'rejected'],
  scheduled: ['under_review', 'published_verified', 'rejected'],
  under_review: ['published_verified', 'rejected'],
  published_verified: ['removal_observed'],
  rejected: [],
  removal_observed: [],
  failed: [],
  canceled: [],
};

export function canTransition(from: IntentState, to: IntentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) throw new SubmitFleetError('invalid_transition', `${from} -> ${to}`);
}

/** States in which a remote write may exist; such intents always keep their dedupe slot. */
export const REMOTE_WRITE_STATES: IntentState[] = [
  'submitted',
  'scheduled',
  'under_review',
  'published_verified',
  'rejected',
  'removal_observed',
  'uncertain',
];

/** Account-queue occupancy: work that counts against a destination's per-account queue limit. */
export const OCCUPYING_STATES: IntentState[] = ['executing', 'submitted', 'scheduled', 'under_review', 'uncertain'];

export const TERMINAL_STATES: IntentState[] = ['published_verified', 'rejected', 'removal_observed', 'failed', 'canceled'];
