import type { Destination } from '../catalog.js';
import type { Product } from '../products.js';

export interface AdapterCapabilities {
  update: boolean;
  withdraw: boolean;
  /** 'tested' = reconcile proven against the live destination; 'limited' = see limitation text. */
  reconcile: 'tested' | 'limited' | 'none';
  reconcileLimitation?: string;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export interface PrepareContext {
  product: Product;
  destination: Destination;
  /** Approved date window, YYYY-MM-DD. */
  earliestDate?: string | null;
  latestDate?: string | null;
  readAsset: (path: string) => Promise<Buffer>;
}

export interface ExecContext {
  intentId: string;
  payload: Record<string, unknown>;
  destination: Destination;
  /** Remote references persisted by earlier attempts (e.g. a created startup id). */
  remoteRefs: Record<string, unknown>;
  /** Persist a remote reference immediately, before the next remote write. */
  recordRemote: (refs: Record<string, unknown>) => Promise<void>;
  /** Credentials are fetched on demand and never returned to callers or logged. */
  credentials: () => Promise<Record<string, string>>;
  fetch: typeof fetch;
  signal: AbortSignal;
  now: () => number;
}

export type ExecResult =
  | {
      kind: 'submitted' | 'scheduled';
      remoteId: string;
      receiptId: string;
      listingUrl?: string | null;
      costCents?: number;
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'needs_human' | 'failed';
      reasonCode: string;
      /** True when a remote write is known to have happened before stopping. */
      externalActionPerformed: boolean;
      evidence?: Record<string, unknown>;
    }
  | { kind: 'uncertain'; reasonCode: string; evidence?: Record<string, unknown> };

export type ReconcileResult =
  | {
      status: 'found';
      state: 'submitted' | 'scheduled' | 'under_review' | 'published_verified' | 'rejected' | 'removal_observed';
      remoteId?: string;
      listingUrl?: string | null;
      evidence: Record<string, unknown>;
    }
  /** Definitive: the destination proves no write exists, so a retry cannot duplicate. */
  | { status: 'absent'; evidence: Record<string, unknown> }
  | { status: 'unknown'; reasonCode: string; evidence?: Record<string, unknown> };

export interface PreflightResult {
  ok: boolean;
  reasonCode?: string;
  evidence?: Record<string, unknown>;
}

export interface Adapter {
  id: string;
  version: string;
  destinationSlug: string;
  method: 'api' | 'browser';
  capabilities(): AdapterCapabilities;
  /** Pure checks against the approved product facts. No network. */
  validate(product: Product, destination: Destination): ValidationIssue[];
  /** Builds the destination payload. Must not perform any remote write (no drafts). */
  prepare(ctx: PrepareContext): Promise<Record<string, unknown>>;
  /** Non-mutating checks immediately before a write: fee/policy evidence, session, dates. */
  preflight(ctx: ExecContext): Promise<PreflightResult>;
  execute(ctx: ExecContext): Promise<ExecResult>;
  reconcile(ctx: ExecContext): Promise<ReconcileResult>;
  update?(ctx: ExecContext): Promise<ExecResult>;
  withdraw?(ctx: ExecContext): Promise<ExecResult>;
}
