/**
 * Credit codes and invites.
 *
 * - A credit code (@profullstack/redeem-credits) grants unit `pro_days`. Every grant goes
 *   through one path, grantProDays(): an idempotent row in plan_grants keyed on
 *   (user, source) and users.pro_until pushed forward. That column is the plan; a future
 *   checkout writes it the same way.
 * - Invites (@profullstack/affiliates) are scarce: 3 per account, one accepted invite per
 *   account, and the bonus (Pro days to both people) is paid at most once per new account
 *   that passes the abuse rules in bonusVerdict().
 *
 * The module tables (credit_*, aff_*) live in the same SQLite file as the app, opened
 * through node:sqlite because both modules' SQLite stores are synchronous. A remote
 * (Turso) app database keeps them in a sidecar file next to the data directory instead.
 */
import { Affiliates, sqliteStore as affiliateStore } from '@profullstack/affiliates';
import { Credits, sqliteStore as creditStore, type Grant } from '@profullstack/redeem-credits';
import MailChecker from 'mailchecker';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { all, one, type Db } from './db.js';
import { SubmitFleetError } from './util.js';

export const PRO_UNIT = 'pro_days';
export const DAY_MS = 86_400_000;
export const MAX_CODE_DAYS = 3660;
export const INVITE_COOKIE = 'sf_invite';
export const INVITE_QUOTA = 3;
/** Only accounts this new can accept an invite. */
export const INVITE_MAX_ACCOUNT_AGE_DAYS = 7;

const envInt = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
};
export const inviteBonusDays = () => envInt('SUBMITFLEET_INVITE_BONUS_DAYS', 14);
export const inviteMonthlyCap = () => envInt('SUBMITFLEET_INVITE_MONTHLY_CAP', 5);

const CODE_WORDS: Record<string, string> = {
  invalid: 'That code is not valid. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code is no longer valid.',
};
const INVITE_WORDS: Record<string, string> = {
  invalid: 'That invite code is not valid.',
  expired: 'That invite has expired. Ask for a new one.',
  used: 'That invite has already been used.',
  self: 'You cannot accept your own invite.',
  revoked: 'That invite was withdrawn.',
  already_invited: 'Your account has already accepted an invite.',
};

/** One mailbox however it is spelled: lowercase, no +tag, no Gmail dots. */
export function canonicalMailbox(email: string): string {
  const [rawLocal = '', rawDomain = ''] = String(email || '').trim().toLowerCase().split('@');
  let domain = rawDomain;
  let local = rawLocal.split('+')[0] ?? '';
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export const isDisposableEmail = (email: string | null | undefined) => !email || !MailChecker.isValid(String(email));

/** Looks like one of our codes (credit CR-/SF- or invite INV-), before any lookup. */
export const looksLikeCode = (s: string) => /^[A-Za-z0-9][A-Za-z0-9 -]{7,40}$/.test(s.trim());

interface BonusUser {
  id: string;
  email: string;
  email_verified_at: string | null;
}

/** Whether an accepted invite pays out. Pure, so the rules are testable without a database. */
export function bonusVerdict(i: {
  invitee: BonusUser | null;
  inviter: BonusUser | null;
  sameNetwork: boolean;
  referred: boolean;
  inviterPaidLast30Days: number;
  cap: number;
  bonusDays: number;
}): { verdict: 'grant' | 'deny' | 'wait'; reason: string } {
  if (!i.bonusDays) return { verdict: 'deny', reason: 'invite bonuses are switched off' };
  if (!i.invitee || !i.inviter) return { verdict: 'deny', reason: 'account missing' };
  if (i.invitee.id === i.inviter.id) return { verdict: 'deny', reason: 'self' };
  if (isDisposableEmail(i.invitee.email)) return { verdict: 'deny', reason: 'throwaway email' };
  if (canonicalMailbox(i.invitee.email) === canonicalMailbox(i.inviter.email)) return { verdict: 'deny', reason: 'same mailbox' };
  if (i.sameNetwork) return { verdict: 'deny', reason: 'same network' };
  if (i.referred) return { verdict: 'deny', reason: 'signed up through a referral link' };
  if (!i.inviter.email_verified_at) return { verdict: 'deny', reason: 'inviter not verified' };
  if (!i.invitee.email_verified_at) return { verdict: 'wait', reason: 'waiting for email confirmation' };
  if (i.inviterPaidLast30Days >= i.cap) return { verdict: 'deny', reason: 'monthly invite bonus cap reached' };
  return { verdict: 'grant', reason: '' };
}

/** The SQLite file that holds the module tables for a given app database URL. */
export function rewardsDbPath(dbUrl: string, sidecar: string): string {
  if (!dbUrl.startsWith('file:')) return sidecar;
  const p = dbUrl.slice('file:'.length).split('?')[0]!;
  return p === ':memory:' || p === '' ? ':memory:' : p.replace(/^\/\/(?=\/)/, '');
}

export class Rewards {
  readonly credits: Credits;
  readonly affiliates: Affiliates;
  private sqlite: DatabaseSync;

  constructor(
    private db: Db,
    path: string,
    private secret: string,
    private now: () => number = Date.now,
  ) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.credits = new Credits(creditStore(this.sqlite), {
      now,
      onGrant: async (userId, grant, source) => {
        await this.applyGrant(userId, grant, source);
      },
    });
    this.affiliates = new Affiliates(affiliateStore(this.sqlite), { now, defaultQuota: INVITE_QUOTA });
  }

  close(): void {
    this.sqlite.close();
  }

  ipHash(ip: string | null | undefined): string | null {
    const v = String(ip ?? '').trim();
    if (!v || v === 'local') return null;
    return createHash('sha256').update(`${this.secret}:invite-ip:${v}`).digest('hex').slice(0, 32);
  }

  private async applyGrant(userId: string, grant: Grant, source: string): Promise<void> {
    if (grant.unit !== PRO_UNIT) {
      console.error(`[submitfleet] grant of unknown unit ${grant.unit} to ${userId} (${source}) ignored`);
      return;
    }
    await this.grantProDays(userId, grant.amount, source);
  }

  /**
   * The one grant path: Pro days written where a paid plan would write them. Idempotent on
   * (user, source); returns the new pro_until, or null when this source was already granted.
   */
  async grantProDays(userId: string, days: number, source: string): Promise<string | null> {
    const count = Math.floor(Number(days));
    if (!Number.isInteger(count) || count < 1 || count > MAX_CODE_DAYS) throw new SubmitFleetError('invalid_request', `a grant must be 1 to ${MAX_CODE_DAYS} days`);
    const ts = new Date(this.now()).toISOString();
    const tx = await this.db.transaction('write');
    try {
      const ins = await tx.execute({ sql: 'INSERT INTO plan_grants (user_id, source, days, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, source) DO NOTHING', args: [userId, source, count, ts] });
      if (ins.rowsAffected !== 1) {
        await tx.rollback();
        return null;
      }
      const u = (await tx.execute({ sql: 'SELECT pro_until FROM users WHERE id = ?', args: [userId] })).rows[0];
      if (!u) throw new SubmitFleetError('not_found', 'user');
      const base = Math.max(this.now(), u.pro_until ? Date.parse(String(u.pro_until)) : 0);
      const until = new Date(base + count * DAY_MS).toISOString();
      await tx.execute({ sql: 'UPDATE users SET pro_until = ?, updated_at = ? WHERE id = ?', args: [until, ts, userId] });
      await tx.commit();
      return until;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  }

  async plan(userId: string) {
    const u = await one<{ pro_until: string | null }>(this.db, 'SELECT pro_until FROM users WHERE id = ?', userId);
    const until = u?.pro_until ?? null;
    const active = !!until && Date.parse(until) > this.now();
    const grants = await all<{ source: string; days: number; created_at: string }>(this.db, 'SELECT source, days, created_at FROM plan_grants WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', userId);
    return {
      plan: active ? 'pro' : 'free',
      pro_until: until,
      pro_active: active,
      days_left: active ? Math.ceil((Date.parse(until!) - this.now()) / DAY_MS) : 0,
      grants: grants.map((g) => ({ source: g.source.startsWith('code:') ? 'code' : g.source.startsWith('invite:') ? 'invite' : g.source, days: Number(g.days), at: g.created_at })),
    };
  }

  async redeem(userId: string, code: string) {
    if (!looksLikeCode(code)) throw new SubmitFleetError('code_invalid', CODE_WORDS.invalid!);
    const r = await this.credits.redeem(code, userId);
    if (!r.ok) throw new SubmitFleetError(`code_${r.reason}`, CODE_WORDS[r.reason] ?? CODE_WORDS.invalid!);
    return { ok: true, days: r.grant.amount, ...(await this.plan(userId)) };
  }

  /** Admin: mint a code worth `days` Pro days. The plaintext is returned once. */
  async mint(o: { days: number; maxRedemptions?: number; expiresInDays?: number | null; label?: string; createdBy?: string }) {
    const days = Math.floor(o.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_CODE_DAYS) throw new SubmitFleetError('invalid_request', `--days must be 1 to ${MAX_CODE_DAYS}`);
    return this.credits.mint({
      grant: { unit: PRO_UNIT, amount: days },
      label: o.label ?? '',
      maxRedemptions: o.maxRedemptions ?? 1,
      expiresAt: o.expiresInDays ? this.now() + o.expiresInDays * DAY_MS : null,
      prefix: 'SF',
      createdBy: o.createdBy,
    });
  }

  // ── Invites ──

  async invites(userId: string) {
    const [quota, list, affiliate] = await Promise.all([this.affiliates.quota(userId), this.affiliates.invites(userId), this.affiliates.affiliateCode(userId)]);
    const acceptances = await all<{ invite_id: string; status: string; reason: string; bonus_days: number }>(this.db, 'SELECT invite_id, status, reason, bonus_days FROM invite_acceptances WHERE inviter_id = ?', userId);
    const byInvite = new Map(acceptances.map((a) => [a.invite_id, a]));
    const mine = await one<{ status: string; reason: string; bonus_days: number }>(this.db, 'SELECT status, reason, bonus_days FROM invite_acceptances WHERE user_id = ?', userId);
    return {
      quota,
      bonus_days: inviteBonusDays(),
      affiliate_code: affiliate,
      invites: list.map((i) => {
        const a = byInvite.get(i.id);
        return {
          id: i.id,
          note: i.note,
          created_at: new Date(i.createdAt).toISOString(),
          expires_at: i.expiresAt ? new Date(i.expiresAt).toISOString() : null,
          used: !!i.usedBy,
          used_at: i.usedAt ? new Date(i.usedAt).toISOString() : null,
          revoked: !!(i as { revokedAt?: number | null }).revokedAt,
          bonus: a ? { status: a.status, reason: a.reason, days: Number(a.bonus_days) } : null,
        };
      }),
      accepted: mine ? { status: mine.status, reason: mine.reason, days: Number(mine.bonus_days) } : null,
    };
  }

  async createInvite(user: BonusUser, note: string | undefined, ip: string | null) {
    if (!user.email_verified_at) throw new SubmitFleetError('owner_required', 'confirm your email before inviting anyone');
    let invite;
    try {
      invite = await this.affiliates.createInvite(user.id, (note ?? '').slice(0, 80));
    } catch (e) {
      if (e instanceof Error && /no invites left/.test(e.message)) throw new SubmitFleetError('invites_exhausted', 'You have used all your invites.');
      throw e;
    }
    await this.db.execute({ sql: 'INSERT INTO invite_origins (invite_id, ip_hash, created_at) VALUES (?, ?, ?) ON CONFLICT (invite_id) DO NOTHING', args: [invite.id, this.ipHash(ip), new Date(this.now()).toISOString()] });
    return { id: invite.id, code: invite.code, expires_at: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null };
  }

  /**
   * Accepts an invite for a new account and settles the bonus. Throws a friendly error for
   * the "Have an invite?" form; the sign-in path calls it through acceptQuietly().
   */
  async acceptInvite(userId: string, code: string, ip: string | null) {
    if (!looksLikeCode(code)) throw new SubmitFleetError('invite_invalid', INVITE_WORDS.invalid!);
    const user = await one<{ id: string; created_at: string }>(this.db, 'SELECT id, created_at FROM users WHERE id = ?', userId);
    if (!user) throw new SubmitFleetError('invite_invalid', INVITE_WORDS.invalid!);
    if (await one(this.db, 'SELECT 1 AS x FROM invite_acceptances WHERE user_id = ?', userId)) throw new SubmitFleetError('invite_already_invited', INVITE_WORDS.already_invited!);
    if (this.now() - Date.parse(user.created_at) > INVITE_MAX_ACCOUNT_AGE_DAYS * DAY_MS) throw new SubmitFleetError('invite_not_new', 'Invites are for new accounts.');
    const r = await this.affiliates.redeemInvite(code, userId);
    if (!r.ok) throw new SubmitFleetError(`invite_${r.reason}`, INVITE_WORDS[r.reason] ?? INVITE_WORDS.invalid!);
    await this.db.execute({
      sql: "INSERT INTO invite_acceptances (user_id, inviter_id, invite_id, ip_hash, status, reason, bonus_days, accepted_at) VALUES (?, ?, ?, ?, 'pending', '', 0, ?) ON CONFLICT (user_id) DO NOTHING",
      args: [userId, r.inviterId, r.inviteId, this.ipHash(ip), new Date(this.now()).toISOString()],
    });
    return { ok: true, bonus: await this.settleInviteBonus(userId) };
  }

  async acceptQuietly(userId: string, code: string | null | undefined, ip: string | null) {
    if (!code) return null;
    try {
      return await this.acceptInvite(userId, code, ip);
    } catch (e) {
      if (!(e instanceof SubmitFleetError)) console.error('[submitfleet] invite accept failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** Pays (or refuses) a pending invite bonus for this invitee, exactly once. */
  async settleInviteBonus(inviteeId: string): Promise<{ status: string; reason: string; days: number } | null> {
    const a = await one<{ user_id: string; inviter_id: string; invite_id: string; ip_hash: string | null; status: string; reason: string; bonus_days: number }>(
      this.db,
      'SELECT * FROM invite_acceptances WHERE user_id = ?',
      inviteeId,
    );
    if (!a) return null;
    if (a.status !== 'pending') return { status: a.status, reason: a.reason, days: Number(a.bonus_days) };
    const cols = 'id, email, email_verified_at';
    const invitee = await one<BonusUser>(this.db, `SELECT ${cols} FROM users WHERE id = ?`, a.user_id);
    const inviter = await one<BonusUser>(this.db, `SELECT ${cols} FROM users WHERE id = ?`, a.inviter_id);
    const origin = await one<{ ip_hash: string | null }>(this.db, 'SELECT ip_hash FROM invite_origins WHERE invite_id = ?', a.invite_id);
    const since = new Date(this.now() - 30 * DAY_MS).toISOString();
    const paid = await one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM invite_acceptances WHERE inviter_id = ? AND status = 'granted' AND settled_at > ?", a.inviter_id, since);
    const days = inviteBonusDays();
    const { verdict, reason } = bonusVerdict({
      invitee,
      inviter,
      sameNetwork: !!(origin?.ip_hash && a.ip_hash && origin.ip_hash === a.ip_hash),
      referred: !!(await this.affiliates.affiliateOf(a.user_id)),
      inviterPaidLast30Days: Number(paid?.n ?? 0),
      cap: inviteMonthlyCap(),
      bonusDays: days,
    });
    const ts = new Date(this.now()).toISOString();
    if (verdict === 'wait') return { status: 'pending', reason, days: 0 };
    // Claim the acceptance first (pending -> granted/denied), so the bonus is paid at most once.
    const claimed = await this.db.execute({
      sql: "UPDATE invite_acceptances SET status = ?, reason = ?, bonus_days = ?, settled_at = ? WHERE user_id = ? AND status = 'pending'",
      args: [verdict === 'grant' ? 'granted' : 'denied', reason, verdict === 'grant' ? days : 0, ts, a.user_id],
    });
    if (claimed.rowsAffected !== 1) return this.settleInviteBonus(inviteeId);
    if (verdict === 'deny') return { status: 'denied', reason, days: 0 };
    await this.grantProDays(a.user_id, days, `invite:${a.invite_id}:invitee`);
    await this.grantProDays(a.inviter_id, days, `invite:${a.invite_id}:inviter`);
    return { status: 'granted', reason: '', days };
  }

  /** First-touch ?ref= attribution for a brand-new account that did not come in on an invite. */
  async attribute(ref: string | null | undefined, userId: string) {
    if (!ref || !/^[A-Za-z0-9_-]{4,40}$/.test(ref)) return null;
    if (await one(this.db, 'SELECT 1 AS x FROM invite_acceptances WHERE user_id = ?', userId)) return null;
    return this.affiliates.attribute(ref, userId).catch(() => null);
  }
}
