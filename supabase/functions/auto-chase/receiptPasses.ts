// Pure selection logic for the two receipt passes of the daily job (phase 2D). No I/O, so it is
// unit-testable without a service client.
//
// GATES. Both passes are governed by the RECEIPT's own state, NOT by trips.chase_settings.enabled (the
// "reminder switch", OFF on every trip). Reminders are additionally gated by trips.receipt_notices_enabled
// (default true). Neither pass touches a receipt whose claims_sent_at is null (old receipts are never
// reminded or auto-applied) or a trip whose balances are frozen.

export const HOUR_MS = 3600_000
/** A reminder goes out when the deadline is within this many hours. */
export const REMINDER_WINDOW_HOURS = 24
/** Nobody who got the "table" notice for this receipt within this many hours gets a reminder too. */
export const TABLE_NOTICE_QUIET_HOURS = 20

export interface ReceiptTripRow {
  name?: string | null
  base_currency?: string | null
  settlement_snapshot?: unknown
  receipt_notices_enabled?: boolean | null
  chase_settings?: unknown
}

export interface ReceiptRow {
  id: string
  trip_id: string
  paid_by: string
  description?: string | null
  currency?: string | null
  claims_sent_at: string | null
  claims_closed_at: string | null
  claim_deadline: string | null
  trips?: ReceiptTripRow | null
}

function isOpenSentReceipt(r: ReceiptRow): boolean {
  if (!r.claims_sent_at || r.claims_closed_at || !r.claim_deadline) return false
  if (!r.trips || r.trips.settlement_snapshot != null) return false // frozen: claims are locked
  return !Number.isNaN(new Date(r.claim_deadline).getTime())
}

/** Deadline in (now, now + 24h], sent, open, not frozen, receipt notices on. A passed deadline is NEVER a reminder: it goes to apply. */
export function selectReminderCandidates(rows: ReadonlyArray<ReceiptRow>, now: Date): ReceiptRow[] {
  return rows.filter((r) => {
    if (!isOpenSentReceipt(r)) return false
    if (r.trips!.receipt_notices_enabled === false) return false
    const t = new Date(r.claim_deadline!).getTime()
    return t > now.getTime() && t <= now.getTime() + REMINDER_WINDOW_HOURS * HOUR_MS
  })
}

/** Deadline already passed (<= now), sent, not closed, not frozen. Independent of receipt_notices_enabled (the rule applies regardless of email). */
export function selectApplyCandidates(rows: ReadonlyArray<ReceiptRow>, now: Date): ReceiptRow[] {
  return rows.filter((r) => isOpenSentReceipt(r) && new Date(r.claim_deadline!).getTime() <= now.getTime())
}

/** A closed receipt's result notices stay recoverable for this many days after it closed. */
export const RESULT_RECOVERY_DAYS = 7

/** Sent, closed within the last 7 days, trip receipt notices on (frozen trips are fine: the result reports something already done). */
export function selectRecentlyClosed(rows: ReadonlyArray<ReceiptRow>, now: Date): ReceiptRow[] {
  const since = now.getTime() - RESULT_RECOVERY_DAYS * 24 * HOUR_MS
  return rows.filter((r) => {
    if (!r.claims_sent_at || !r.claims_closed_at || !r.trips) return false
    if (r.trips.receipt_notices_enabled === false) return false
    const t = new Date(r.claims_closed_at).getTime()
    return Number.isFinite(t) && t >= since && t <= now.getTime() + HOUR_MS
  })
}

export interface ClaimAmounts { user_id: string; leftover_amount?: number | string | null; amount_owed?: number | string | null }

/**
 * Who was charged part of the unclaimed items (sum of leftover_amount > 0), with their whole share of the receipt, minus the payer
 * (never emailed about their own receipt) and anyone in `alreadyNotified`. Amounts are in currency units. A receipt reopened and closed again
 * has its leftovers rebuilt from scratch, so these are always the amounts of the CURRENT close; whether the person is told again is decided by
 * decideResultSequence (once per close, a second time only if the amount changed, cap 2).
 */
export function resultRecoveryRecipients(args: {
  claims: ReadonlyArray<ClaimAmounts>
  payerId: string
  alreadyNotified: ReadonlySet<string>
}): Array<{ userId: string; amount: number; totalAfter: number }> {
  const by = new Map<string, { amount: number; total: number }>()
  for (const c of args.claims) {
    const cur = by.get(c.user_id) ?? { amount: 0, total: 0 }
    cur.amount += Number(c.leftover_amount ?? 0) || 0
    cur.total += Number(c.amount_owed ?? 0) || 0
    by.set(c.user_id, cur)
  }
  const out: Array<{ userId: string; amount: number; totalAfter: number }> = []
  for (const [userId, v] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (userId === args.payerId || args.alreadyNotified.has(userId) || !(v.amount > 0.0000001)) continue
    out.push({ userId, amount: v.amount, totalAfter: v.total })
  }
  return out
}

/** Hints from apply_receipt_deadline that will never change on their own: not an error, not worth a line every day. */
export const PERMANENT_APPLY_HINTS: ReadonlySet<string> = new Set(['frozen', 'not_found', 'not_itemised', 'closed', 'claims_closed', 'not_sent', 'currency_unsupported'])
export function isPermanentApplyRefusal(error: { hint?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (PERMANENT_APPLY_HINTS.has((error.hint ?? '').toLowerCase())) return true
  return /not itemi[sz]ed/i.test(error.message ?? '')
}

export const tableNoticeKey = (expenseId: string, userId: string) => `notice:receipt:${expenseId}:${userId}:table`

/** Every table-email key a person can have (first send, then the re-sends :2 and :3). */
export const tableNoticeKeys = (expenseId: string, userId: string): string[] => [tableNoticeKey(expenseId, userId), `${tableNoticeKey(expenseId, userId)}:2`, `${tableNoticeKey(expenseId, userId)}:3`]

export function tableNoticeCutoffIso(now: Date): string {
  return new Date(now.getTime() - TABLE_NOTICE_QUIET_HOURS * HOUR_MS).toISOString()
}

/**
 * Who is reminded: tagged (the DB's _receipt_tagged), minus anyone with a response of ANY kind, minus the payer
 * (never reminded about their own receipt), minus anyone who got the "table" notice within 20 hours.
 * Can only shrink `tagged`.
 */
export function reminderRecipients(args: {
  tagged: ReadonlyArray<string>
  payerId: string
  responded: ReadonlySet<string>
  recentTableNotice: ReadonlySet<string>
}): string[] {
  const out: string[] = []
  for (const u of new Set(args.tagged)) {
    if (u === args.payerId || args.responded.has(u) || args.recentTableNotice.has(u)) continue
    out.push(u)
  }
  return out
}

export interface ApplyPerson {
  user_id: string
  amount?: number | null
  total_after?: number | null
}
export interface ApplyResult {
  /** 'not_itemised': the receipt was converted back to a plain expense; nothing to apply, nothing to retry (quiet, not an error). */
  skipped?: string | null
  /** 'not_sent' | 'not_due': the service-role soft refusals. */
  reason?: string | null
  applied?: boolean
  already_applied?: boolean
  people?: ReadonlyArray<ApplyPerson> | null
  notify_user_ids?: ReadonlyArray<string> | null
  notices_enabled?: boolean | null
  currency?: string | null
}

/** People whose share increased and who may be told. Nothing when not applied now (idempotent) or notices are off. */
export function resultRecipients(r: ApplyResult | null | undefined): Array<{ userId: string; amount: number; totalAfter: number | null }> {
  if (!r || r.applied !== true || r.already_applied === true || r.notices_enabled === false) return []
  const allowed = Array.isArray(r.notify_user_ids) ? new Set(r.notify_user_ids) : null
  const out: Array<{ userId: string; amount: number; totalAfter: number | null }> = []
  const seen = new Set<string>()
  for (const p of r.people ?? []) {
    const amount = Number(p.amount ?? 0)
    if (!(amount > 0) || seen.has(p.user_id)) continue
    if (allowed && !allowed.has(p.user_id)) continue
    seen.add(p.user_id)
    out.push({ userId: p.user_id, amount, totalAfter: typeof p.total_after === 'number' ? p.total_after : null })
  }
  return out
}

/**
 * Digest chase kind `unclaimed_items` is retired for receipts SENT to the table (they have their own notices).
 * Never-sent receipts (claims_sent_at null/absent, including before the migration) are unchanged.
 */
export function isUnclaimedChaseRetired(e: { claims_sent_at?: string | null }): boolean {
  return !!e.claims_sent_at
}

interface ErrLike { code?: string | null; message?: string | null; details?: string | null }

export function isMissingFunction(error: ErrLike | null | undefined): boolean {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883') return true
  return /could not find the function|function .* does not exist/i.test(`${error.message ?? ''} ${error.details ?? ''}`)
}

export function isMissingColumnOrTable(error: ErrLike | null | undefined): boolean {
  if (!error) return false
  if (['42703', '42P01', 'PGRST205', 'PGRST204'].includes(error.code ?? '')) return true
  return /does not exist|could not find the .* (column|table)/i.test(`${error.message ?? ''} ${error.details ?? ''}`)
}
