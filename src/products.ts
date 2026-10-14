import { all, one, run, type Db } from './db.js';
import { canonicalProductKey, newId, nowIso, parseJson, SubmitFleetError } from './util.js';

export interface Product {
  id: string;
  workspace_id: string;
  canonical_key: string;
  url: string;
  name: string | null;
  tagline: string | null;
  description: string | null;
  categories: string[];
  contact_email: string | null;
  logo_path: string | null;
  /** Owner-approved facts. Adapters may only use these, never invent claims. */
  facts: Record<string, unknown>;
  /** Destination-specific values, keyed by destination slug (e.g. a category id). */
  destination_fields: Record<string, Record<string, unknown>>;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductInput {
  url: string;
  name?: string | null;
  tagline?: string | null;
  description?: string | null;
  categories?: string[];
  contact_email?: string | null;
  logo_path?: string | null;
  facts?: Record<string, unknown>;
  destination_fields?: Record<string, Record<string, unknown>>;
}

function rowToProduct(r: Record<string, unknown>): Product {
  return {
    ...(r as unknown as Product),
    categories: parseJson(r.categories_json, []),
    facts: parseJson(r.facts_json, {}),
    destination_fields: parseJson(r.destination_fields_json, {}),
  };
}

export async function createProduct(db: Db, workspaceId: string, input: ProductInput): Promise<Product> {
  const key = canonicalProductKey(input.url);
  const dup = await one(db, 'SELECT id FROM products WHERE workspace_id = ? AND canonical_key = ?', workspaceId, key);
  if (dup) throw new SubmitFleetError('product_exists', `product ${key} already exists`, { id: dup.id });
  const now = nowIso();
  const id = newId('prd');
  await run(
    db,
    `INSERT INTO products (id, workspace_id, canonical_key, url, name, tagline, description, categories_json, contact_email, logo_path, facts_json, destination_fields_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, workspaceId, key, input.url, input.name, input.tagline, input.description,
    JSON.stringify(input.categories ?? []), input.contact_email, input.logo_path,
    JSON.stringify(input.facts ?? {}), JSON.stringify(input.destination_fields ?? {}), now, now,
  );
  return (await getProduct(db, workspaceId, id))!;
}

export async function getProduct(db: Db, workspaceId: string, id: string): Promise<Product | null> {
  const r = await one<Record<string, unknown>>(db, 'SELECT * FROM products WHERE workspace_id = ? AND id = ?', workspaceId, id);
  return r ? rowToProduct(r) : null;
}

export async function requireProduct(db: Db, workspaceId: string, id: string): Promise<Product> {
  const p = await getProduct(db, workspaceId, id);
  if (!p) throw new SubmitFleetError('not_found', `product ${id}`);
  return p;
}

export async function listProducts(db: Db, workspaceId: string, limit = 100, offset = 0): Promise<Product[]> {
  const rows = await all<Record<string, unknown>>(db, 'SELECT * FROM products WHERE workspace_id = ? ORDER BY created_at LIMIT ? OFFSET ?', workspaceId, limit, offset);
  return rows.map(rowToProduct);
}

/** Any content change clears the owner's approval of the facts. */
export async function updateProduct(db: Db, workspaceId: string, id: string, patch: Partial<ProductInput>): Promise<Product> {
  const p = await requireProduct(db, workspaceId, id);
  if (patch.url && canonicalProductKey(patch.url) !== p.canonical_key) {
    throw new SubmitFleetError('canonical_identity_immutable', 'create a new product for a different canonical URL');
  }
  const merged = {
    url: patch.url ?? p.url,
    name: patch.name !== undefined ? patch.name : p.name,
    tagline: patch.tagline !== undefined ? patch.tagline : p.tagline,
    description: patch.description !== undefined ? patch.description : p.description,
    categories: patch.categories ?? p.categories,
    contact_email: patch.contact_email !== undefined ? patch.contact_email : p.contact_email,
    logo_path: patch.logo_path !== undefined ? patch.logo_path : p.logo_path,
    facts: patch.facts ?? p.facts,
    destination_fields: patch.destination_fields ?? p.destination_fields,
  };
  await run(
    db,
    `UPDATE products SET url = ?, name = ?, tagline = ?, description = ?, categories_json = ?, contact_email = ?, logo_path = ?,
       facts_json = ?, destination_fields_json = ?, approved_at = NULL, approved_by = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    merged.url, merged.name, merged.tagline, merged.description, JSON.stringify(merged.categories), merged.contact_email,
    merged.logo_path, JSON.stringify(merged.facts), JSON.stringify(merged.destination_fields), nowIso(), id, workspaceId,
  );
  return requireProduct(db, workspaceId, id);
}

export async function approveProductFacts(db: Db, workspaceId: string, id: string, ownerId: string): Promise<Product> {
  await requireProduct(db, workspaceId, id);
  await run(db, 'UPDATE products SET approved_at = ?, approved_by = ? WHERE id = ? AND workspace_id = ?', nowIso(), ownerId, id, workspaceId);
  return requireProduct(db, workspaceId, id);
}

/** Local data only. Remote listings are never deleted by this. */
export async function deleteProduct(db: Db, workspaceId: string, id: string): Promise<void> {
  const used = await one(db, 'SELECT id FROM intents WHERE product_id = ? LIMIT 1', id);
  if (used) throw new SubmitFleetError('product_has_submissions', 'product has submission history kept for duplicate prevention');
  await run(db, 'DELETE FROM campaign_targets WHERE campaign_id IN (SELECT id FROM campaigns WHERE product_id = ?)', id);
  await run(db, 'DELETE FROM campaigns WHERE product_id = ? AND workspace_id = ?', id, workspaceId);
  const n = await run(db, 'DELETE FROM products WHERE id = ? AND workspace_id = ?', id, workspaceId);
  if (!n) throw new SubmitFleetError('not_found', `product ${id}`);
}
