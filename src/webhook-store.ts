/**
 * The webhook hub's store on SubmitFleet's own libSQL client.
 *
 * `@profullstack/webhooks` ships stores for bun:sqlite/node:sqlite and for a pg
 * pool. SubmitFleet talks to its database through the async @libsql/client (a
 * local file in production, or Turso), so the hub's `WebhookStore` interface is
 * implemented here over the package's own two tables (`schemaSql('sqlite')`,
 * created by migration 5). Times are unix milliseconds, as the hub counts them.
 */
import type { Delivery, Endpoint, WebhookStore } from '@profullstack/webhooks';
import { all, run, type Db } from './db.js';

const ENDPOINT_COLS = 'id, owner, url, secret, events, description, enabled, failures, disabled_reason, created_at, updated_at';
const DELIVERY_COLS = 'id, endpoint_id, owner, event_id, event_type, payload, status, attempts, next_at, last_status, last_error, created_at, updated_at';

const ENDPOINT_FIELDS: Partial<Record<keyof Endpoint, string>> = {
  url: 'url',
  secret: 'secret',
  events: 'events',
  description: 'description',
  enabled: 'enabled',
  failures: 'failures',
  disabledReason: 'disabled_reason',
  updatedAt: 'updated_at',
};
const DELIVERY_FIELDS: Partial<Record<keyof Delivery, string>> = {
  status: 'status',
  attempts: 'attempts',
  nextAt: 'next_at',
  lastStatus: 'last_status',
  lastError: 'last_error',
  updatedAt: 'updated_at',
};

type Row = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toEndpoint(r: Row | undefined): Endpoint | null {
  if (!r) return null;
  let events: string[] = ['*'];
  try {
    const parsed: unknown = JSON.parse(String(r.events));
    if (Array.isArray(parsed)) events = parsed.map(String);
  } catch {
    // keep the default: every event
  }
  return {
    id: String(r.id),
    owner: String(r.owner),
    url: String(r.url),
    secret: String(r.secret),
    events,
    description: r.description == null ? '' : String(r.description),
    enabled: Number(r.enabled) === 1,
    failures: Number(r.failures ?? 0),
    disabledReason: r.disabled_reason == null ? null : String(r.disabled_reason),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toDelivery(r: Row | undefined): Delivery | null {
  if (!r) return null;
  return {
    id: String(r.id),
    endpointId: String(r.endpoint_id),
    owner: String(r.owner),
    eventId: String(r.event_id),
    eventType: String(r.event_type),
    payload: String(r.payload),
    status: String(r.status) as Delivery['status'],
    attempts: Number(r.attempts ?? 0),
    nextAt: Number(r.next_at),
    lastStatus: numOrNull(r.last_status),
    lastError: r.last_error == null ? null : String(r.last_error),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function sqlValue(key: string, value: unknown): unknown {
  if (key === 'events') return JSON.stringify(value);
  if (key === 'enabled') return value ? 1 : 0;
  return value ?? null;
}

export function libsqlWebhookStore(db: Db): WebhookStore {
  const update = async <T extends object>(table: string, fields: Partial<Record<keyof T, string>>, id: string, patch: Partial<T>) => {
    const keys = (Object.keys(patch) as (keyof T)[]).filter((k) => fields[k] && patch[k] !== undefined);
    if (!keys.length) return;
    await run(db, `UPDATE ${table} SET ${keys.map((k) => `${fields[k]} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => sqlValue(String(k), patch[k])), id);
  };
  return {
    async insertEndpoint(e) {
      await run(
        db,
        `INSERT INTO webhook_endpoints (${ENDPOINT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.id, e.owner, e.url, e.secret, JSON.stringify(e.events), e.description, e.enabled ? 1 : 0, e.failures, e.disabledReason, e.createdAt, e.updatedAt,
      );
    },
    async getEndpoint(id) {
      return toEndpoint((await all<Row>(db, `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE id = ?`, id))[0]);
    },
    async listEndpoints(owner) {
      const rows = await all<Row>(db, `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE owner = ? ORDER BY created_at`, owner);
      return rows.map((r) => toEndpoint(r)!);
    },
    updateEndpoint: (id, patch) => update<Endpoint>('webhook_endpoints', ENDPOINT_FIELDS, id, patch),
    async deleteEndpoint(id) {
      await run(db, 'DELETE FROM webhook_deliveries WHERE endpoint_id = ?', id);
      await run(db, 'DELETE FROM webhook_endpoints WHERE id = ?', id);
    },
    async insertDeliveries(rows) {
      for (const d of rows) {
        await run(
          db,
          `INSERT INTO webhook_deliveries (${DELIVERY_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          d.id, d.endpointId, d.owner, d.eventId, d.eventType, d.payload, d.status, d.attempts, d.nextAt, d.lastStatus, d.lastError, d.createdAt, d.updatedAt,
        );
      }
    },
    async getDelivery(id) {
      return toDelivery((await all<Row>(db, `SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id = ?`, id))[0]);
    },
    async listDeliveries({ owner, endpointId, limit = 50 }) {
      const rows = endpointId
        ? await all<Row>(db, `SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE owner = ? AND endpoint_id = ? ORDER BY created_at DESC LIMIT ?`, owner, endpointId, limit)
        : await all<Row>(db, `SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE owner = ? ORDER BY created_at DESC LIMIT ?`, owner, limit);
      return rows.map((r) => toDelivery(r)!);
    },
    updateDelivery: (id, patch) => update<Delivery>('webhook_deliveries', DELIVERY_FIELDS, id, patch),
    /**
     * One statement selects and leases the due rows, so a second drainer (another
     * process on the same Turso database) can never take a row this one holds.
     */
    async claimDue(now, limit, leaseMs) {
      const rows = await all<Row>(
        db,
        `UPDATE webhook_deliveries SET next_at = ?
          WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?)
            AND status = 'pending' AND next_at <= ?
          RETURNING ${DELIVERY_COLS}`,
        now + leaseMs, now, limit, now,
      );
      return rows.map((r) => toDelivery(r)!);
    },
    async prune(before) {
      await run(db, "DELETE FROM webhook_deliveries WHERE status <> 'pending' AND updated_at < ?", before);
    },
  };
}
