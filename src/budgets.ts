import { one, run, type Db } from './db.js';
import { newId, nowIso } from './util.js';

export async function createBudget(db: Db, workspaceId: string, campaignId: string, limitCents: number): Promise<string> {
  const existing = await one<{ id: string }>(db, 'SELECT id FROM budgets WHERE campaign_id = ?', campaignId);
  if (existing) {
    await run(db, 'UPDATE budgets SET limit_cents = MAX(?, reserved_cents + spent_cents) WHERE id = ?', limitCents, existing.id);
    return existing.id;
  }
  const id = newId('bud');
  await run(db, 'INSERT INTO budgets (id, workspace_id, campaign_id, limit_cents) VALUES (?, ?, ?, ?)', id, workspaceId, campaignId, limitCents);
  return id;
}

/**
 * Atomically reserves operating spend. A single conditional UPDATE is the whole
 * check-and-increment, so parallel workers cannot overspend the same balance.
 */
export async function reserve(db: Db, budgetId: string, intentId: string, amountCents: number): Promise<string | null> {
  if (amountCents < 0) throw new Error('negative_reservation');
  const n = await run(
    db,
    'UPDATE budgets SET reserved_cents = reserved_cents + ? WHERE id = ? AND reserved_cents + spent_cents + ? <= limit_cents',
    amountCents,
    budgetId,
    amountCents,
  );
  if (n !== 1) return null;
  const id = newId('res');
  await run(db, "INSERT INTO reservations (id, budget_id, intent_id, amount_cents, status, created_at) VALUES (?, ?, ?, ?, 'reserved', ?)", id, budgetId, intentId, amountCents, nowIso());
  return id;
}

/** Settles actual usage. Spend above the reservation is capped and flagged, never silently absorbed. */
export async function settle(db: Db, reservationId: string, actualCents: number): Promise<{ charged: number; overrun: number }> {
  const r = await one<{ budget_id: string; amount_cents: number; status: string }>(db, 'SELECT budget_id, amount_cents, status FROM reservations WHERE id = ?', reservationId);
  if (!r || r.status !== 'reserved') return { charged: 0, overrun: 0 };
  const amount = Number(r.amount_cents);
  const charged = Math.min(Math.max(actualCents, 0), amount);
  const changed = await run(db, "UPDATE reservations SET status = 'settled', actual_cents = ? WHERE id = ? AND status = 'reserved'", actualCents, reservationId);
  if (changed) await run(db, 'UPDATE budgets SET reserved_cents = reserved_cents - ?, spent_cents = spent_cents + ? WHERE id = ?', amount, charged, r.budget_id);
  return { charged, overrun: Math.max(actualCents - amount, 0) };
}

export async function release(db: Db, reservationId: string): Promise<void> {
  const r = await one<{ budget_id: string; amount_cents: number }>(db, "SELECT budget_id, amount_cents FROM reservations WHERE id = ? AND status = 'reserved'", reservationId);
  if (!r) return;
  const changed = await run(db, "UPDATE reservations SET status = 'released' WHERE id = ? AND status = 'reserved'", reservationId);
  if (changed) await run(db, 'UPDATE budgets SET reserved_cents = reserved_cents - ? WHERE id = ?', Number(r.amount_cents), r.budget_id);
}

export async function getBudget(db: Db, campaignId: string): Promise<{ id: string; limit_cents: number; reserved_cents: number; spent_cents: number } | null> {
  return one(db, 'SELECT id, limit_cents, reserved_cents, spent_cents FROM budgets WHERE campaign_id = ?', campaignId);
}
