/**
 * The I/O half of the receipt notices (table / reminder / result). Callers (receipt-notice, and the daily job in auto-chase) have ALREADY
 * authorised the request; everything else is re-checked here against the database with the service-role client: the state of the
 * receipt, both people on the trip, the email gates, the trip's receipt-notice switch, the shared per-person daily cap and the dedupe row.
 *
 * Dedupe: a `notifications` row (unique dedupe_key) is inserted BEFORE the send, so two concurrent calls send once. If the send then
 * fails the row is deleted so a retry can send; gate skips write nothing. Personal links carry a secret token: the raw token exists only
 * in the email; the database gets its SHA-256. No token is ever logged.
 */
import type { EmailSender } from './emailSender.ts'
import { bothOnTrip, claimDedupe, type SupabaseClient } from './paymentNoticeSend.ts'
import { displayFirstName } from './paymentNoticeCore.ts'
import { generateToken, hashToken } from './paymentToken.ts'
import {
  RECEIPT_KINDS,
  RECEIPT_REMINDER_KIND,
  RECEIPT_RESULT_KIND,
  RECEIPT_TABLE_FP_KIND,
  RECEIPT_TABLE_KIND,
  assignedFingerprint,
  decideReceiptNotice,
  decideReminderEngagement,
  decideReminderSequence,
  decideResultSequence,
  decideTableSequence,
  latestOwnChange,
  overReceiptCap,
  personItems,
  receiptAppUrl,
  receiptPageUrl,
  reminderNoticeKey,
  renderClaimEmail,
  renderResultEmail,
  closedEarly,
  resultNoticeKey,
  tableFingerprintKey,
  tableNoticeKey,
  type ClaimRow,
  type LineRow,
  type PersonItem,
  type ReceiptFacts,
  type ReceiptSkipReason,
  type RecipientOutcome,
} from './receiptNoticeCore.ts'

export type { SupabaseClient }

export type ReceiptNoticeResult = { sent: true; reason: null } | { sent: false; reason: ReceiptSkipReason | 'send_failed' | 'token_failed' | 'state_failed' }

const fail = (reason: Exclude<ReceiptNoticeResult, { sent: true }>['reason']): ReceiptNoticeResult => ({ sent: false, reason })
const OK: ReceiptNoticeResult = { sent: true, reason: null }

interface ExpenseRow {
  /** The receipt's explicit participant list ([] or null = everyone active). An explicit list wins over declined/cancelled status. */
  participant_ids?: string[] | null
  id: string
  trip_id: string
  description: string | null
  currency: string | null
  amount: number | null
  paid_by: string | null
  claim_deadline: string | null
  claims_sent_at: string | null
  claims_closed_at: string | null
}
interface UserRow {
  id: string
  email: string | null
  full_name: string | null
  first_name: string | null
  email_notifications_enabled: boolean | null
}
interface TripRow {
  id: string
  name: string
  base_currency: string | null
  settlement_snapshot: unknown
  receipt_notices_enabled: boolean | null
}

const USER_COLS = 'id, email, full_name, first_name, email_notifications_enabled'

/** The columns / functions of migration B do not exist yet: every receipt notice then quietly does nothing. */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204' || error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find .* (column|table)/i.test(error.message ?? ''))
}

type Loaded = { ok: true; expense: ExpenseRow; trip: TripRow; payer: UserRow | undefined; recipient: UserRow | undefined; facts: ReceiptFacts; title: string; currency: string } | { ok: false; reason: 'not_found' | 'not_available' | 'state_failed' }

async function loadContext(admin: SupabaseClient, expenseId: string, userId: string): Promise<Loaded> {
  const { data: e, error: eErr } = await admin
    .from('expenses')
    .select('id, trip_id, description, currency, amount, paid_by, claim_deadline, claims_sent_at, claims_closed_at, participant_ids')
    .eq('id', expenseId)
    .maybeSingle()
  if (eErr) return { ok: false, reason: isMissingColumn(eErr) ? 'not_available' : 'state_failed' }
  if (!e) return { ok: false, reason: 'not_found' }
  const expense = e as ExpenseRow
  const { data: t, error: tErr } = await admin
    .from('trips')
    .select('id, name, base_currency, settlement_snapshot, receipt_notices_enabled')
    .eq('id', expense.trip_id)
    .maybeSingle()
  if (tErr) return { ok: false, reason: isMissingColumn(tErr) ? 'not_available' : 'state_failed' }
  if (!t) return { ok: false, reason: 'not_found' }
  const trip = t as TripRow
  const ids = [userId, expense.paid_by].filter((x): x is string => !!x)
  const { data: users } = await admin.from('users').select(USER_COLS).in('id', ids)
  const byId = new Map(((users ?? []) as UserRow[]).map((u) => [u.id, u]))
  return {
    ok: true,
    expense,
    trip,
    payer: expense.paid_by ? byId.get(expense.paid_by) : undefined,
    recipient: byId.get(userId),
    facts: {
      noticesEnabled: trip.receipt_notices_enabled,
      frozen: trip.settlement_snapshot !== null && trip.settlement_snapshot !== undefined,
      claimsSentAt: expense.claims_sent_at,
      claimsClosedAt: expense.claims_closed_at,
      claimDeadline: expense.claim_deadline,
    },
    title: (expense.description ?? '').replace(/\s+/g, ' ').trim() || 'a receipt',
    currency: expense.currency || trip.base_currency || 'GBP',
  }
}

/** True when `userId` has already been sent the daily maximum of receipt notices (all kinds together). A count error counts as over. */
async function overCap(admin: SupabaseClient, userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 864e5).toISOString()
  const { count } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('kind', [...RECEIPT_KINDS])
    .gte('sent_at', since)
  return overReceiptCap(count)
}

interface NotificationRow {
  dedupe_key: string
  kind: string
  sent_at: string | null
}

/** Every receipt notification (and table marker) this person has for this receipt, oldest first. */
async function priorNotices(admin: SupabaseClient, expenseId: string, userId: string): Promise<NotificationRow[] | null> {
  const { data, error } = await admin
    .from('notifications')
    .select('dedupe_key, kind, sent_at')
    .eq('entity_id', expenseId)
    .eq('user_id', userId)
    .in('kind', [...RECEIPT_KINDS, RECEIPT_TABLE_FP_KIND])
  if (error) return null
  return ((data ?? []) as NotificationRow[]).slice().sort((a, b) => Date.parse(a.sent_at ?? '') - Date.parse(b.sent_at ?? ''))
}

async function loadLinesAndClaims(admin: SupabaseClient, expenseId: string): Promise<{ lines: LineRow[]; claims: ClaimRow[] } | null> {
  const [{ data: lines, error: lErr }, { data: claims, error: cErr }] = await Promise.all([
    admin.from('expense_line_items').select('id, line_number, name_original, name_english, quantity, total_amount, shared_by_all').eq('expense_id', expenseId),
    admin.from('expense_item_claims').select('line_item_id, user_id, quantity_claimed, leftover_quantity, amount_owed, leftover_amount, created_by, updated_at').eq('expense_id', expenseId),
  ])
  if (lErr || cErr) return null
  return { lines: (lines ?? []) as LineRow[], claims: (claims ?? []) as ClaimRow[] }
}

/** When the payer last reopened this receipt (activity row `receipt_reopened`), or null. Fail-soft: an unreadable feed means "never reopened". */
async function lastReopenedAt(admin: SupabaseClient, tripId: string, expenseId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.from('activity_feed').select('created_at, entity').eq('trip_id', tripId).eq('verb', 'receipt_reopened')
    if (error) return null
    let best: string | null = null
    for (const r of (data ?? []) as Array<{ created_at?: string | null; entity?: { id?: string } | null }>) {
      if (r.entity?.id !== expenseId || !r.created_at) continue
      if (!best || Date.parse(r.created_at) > Date.parse(best)) best = r.created_at
    }
    return best
  } catch {
    return null
  }
}

async function hasResponse(admin: SupabaseClient, expenseId: string, userId: string): Promise<boolean | null> {
  const { data, error } = await admin.from('expense_claim_responses').select('response').eq('expense_id', expenseId).eq('user_id', userId).maybeSingle()
  if (error) return isMissingColumn(error) ? false : null
  return !!data
}

/** The recipient's response ('done' | 'not_there' | ...), or undefined when none; null when the lookup failed. */
async function responseOf(admin: SupabaseClient, expenseId: string, userId: string): Promise<string | undefined | null> {
  const { data, error } = await admin.from('expense_claim_responses').select('response').eq('expense_id', expenseId).eq('user_id', userId).maybeSingle()
  if (error) return isMissingColumn(error) ? undefined : null
  return data ? String((data as { response?: unknown }).response ?? '') : undefined
}

/**
 * Who may be emailed about a receipt. Removed people (no trip_participants row) never are. An EXPLICIT participant list on the receipt wins:
 * a person on it is on the receipt and is emailed like anyone else, declined / cancelled / inactive included (they still have a row).
 * Without an explicit list, an inactive or declined / cancelled person is excluded unless they made a claim of their own (created_by = them;
 * items the payer put them down for do not count).
 * Returns 'ok', 'excluded', or 'failed' (unknown: send nothing).
 */
async function participantEligibility(admin: SupabaseClient, tripId: string, userId: string, holdsOwnClaim: boolean, onExplicitList = false): Promise<'ok' | 'excluded' | 'failed'> {
  const { data, error } = await admin.from('trip_participants').select('active, confirmation_status').eq('trip_id', tripId).eq('user_id', userId)
  if (error) return isMissingColumn(error) ? 'ok' : 'failed'
  const rows = (data ?? []) as Array<{ active?: boolean | null; confirmation_status?: string | null }>
  if (rows.length === 0) return 'excluded'
  const inactive = rows.every((r) => r.active === false || ['declined', 'cancelled'].includes(String(r.confirmation_status ?? '')))
  return inactive && !holdsOwnClaim && !onExplicitList ? 'excluded' : 'ok'
}

const onExplicitList = (e: ExpenseRow, userId: string) => Array.isArray(e.participant_ids) && e.participant_ids.length > 0 && e.participant_ids.includes(userId)

const ownClaimQty = (c: ClaimRow) => Number(c.quantity_claimed ?? 0) - Number(c.leftover_quantity ?? 0)
/** A claim the person made themselves on an ordinary line (not one the payer put them down for; shares on table items are derived and never count). */
const holdsOwnClaim = (claims: ClaimRow[], lines: LineRow[], userId: string) => {
  const table = new Set(lines.filter((l) => l.shared_by_all).map((l) => l.id))
  return claims.some((c) => c.user_id === userId && c.created_by === userId && ownClaimQty(c) > 0 && !table.has(c.line_item_id))
}

const dedupeRow = (sender: EmailSender, tripId: string, userId: string, expenseId: string, kind: string, key: string) => ({
  trip_id: tripId,
  user_id: userId,
  kind,
  entity_type: 'expense',
  entity_id: expenseId,
  channel: sender.channel,
  dedupe_key: key,
})

type TokenIssue = { ok: true; token: string; rollback: () => Promise<void> } | { ok: false; reason: ReceiptSkipReason | 'token_failed' }

/**
 * A new random token per email; only its hash reaches the database. Anything but 'issued' means do not send. The link's lifetime is the
 * database's business (it expires at the deadline + 7 days and follows deadline changes), so nothing here assumes a length.
 * The database retires a person's oldest links once they hold more than 5, so a token that never reached anyone must not cost them an
 * older, delivered link: `rollback()` (call it when the provider did not accept the email) deletes the new token and restores whichever
 * of the person's links were active just before it was issued.
 */
async function issueToken(admin: SupabaseClient, expenseId: string, userId: string): Promise<TokenIssue> {
  const token = generateToken()
  let before: string[] = []
  try {
    const { data } = await admin.from('receipt_claim_tokens').select('id').eq('expense_id', expenseId).eq('user_id', userId).is('used_at', null)
    before = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
  } catch {
    before = []
  }
  const { data, error } = await admin.rpc('issue_receipt_claim_token', { p_expense_id: expenseId, p_user_id: userId, p_token_hash: await hashToken(token) })
  if (error) return { ok: false, reason: 'token_failed' }
  const d = data as { result?: string; token_id?: string } | null
  const result = d?.result
  if (result === 'issued') {
    const tokenId = d?.token_id
    const rollback = async () => {
      try {
        if (tokenId) await admin.from('receipt_claim_tokens').delete().eq('id', tokenId)
        if (before.length > 0) await admin.from('receipt_claim_tokens').update({ used_at: null }).in('id', before)
      } catch (e) {
        logFailure('token rollback', e)
      }
    }
    return { ok: true, token, rollback }
  }
  if (result === 'not_on_receipt') return { ok: false, reason: 'not_on_receipt' }
  if (result === 'claims_closed' || result === 'closed') return { ok: false, reason: 'closed' } // 'closed' is the pre-rename spelling
  if (result === 'frozen') return { ok: false, reason: 'frozen' }
  if (result === 'not_sent') return { ok: false, reason: 'not_open' }
  return { ok: false, reason: 'token_failed' }
}

function logFailure(what: string, e: unknown) {
  // Message only (provider errors); never the request, the address or a link.
  console.error(`[receipt-notice] ${what} failed:`, e instanceof Error ? e.message.replace(/[^\s<>"',;]+@[^\s<>"',;]+/g, '[email]').slice(0, 200) : 'unknown')
}

/**
 * The "put you down" / "tell us what you had" email to one person. `actorId` = who triggered the send (never emailed).
 * First email: always (subject to the gates). Later: only if somebody else changed the items they put this person down for since the
 * previous email, at most 3 emails per person per receipt. `force` (the payer asked for this person again) skips only the "items changed" rule:
 * every other gate, the per-receipt cap of 3 and the daily cap still apply.
 */
export async function sendReceiptTableNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { expenseId: string; userId: string; actorId: string | null; appBaseUrl: string; now?: Date; force?: boolean }
): Promise<ReceiptNoticeResult> {
  const now = opts.now ?? new Date()
  const ctx = await loadContext(admin, opts.expenseId, opts.userId)
  if (!ctx.ok) return fail(ctx.reason)
  const { expense, trip, payer, recipient, facts, title, currency } = ctx
  if (!recipient || !payer) return fail('not_found')

  const decision = decideReceiptNotice({
    type: 'table',
    receipt: facts,
    recipient: { email: recipient.email, emailNotificationsEnabled: recipient.email_notifications_enabled, channelAvailable: sender.available },
    recipientId: opts.userId,
    actorId: opts.actorId,
    now,
  })
  if (!decision.send) return fail(decision.reason!)
  if (opts.userId === expense.paid_by) return fail('same_person') // the payer is never emailed about their own receipt (an organiser may be the sender)
  if (!(await bothOnTrip(admin, trip.id, expense.paid_by!, opts.userId))) return fail('not_found')
  const responded = await hasResponse(admin, expense.id, opts.userId)
  if (responded === null) return fail('state_failed')
  if (responded) return fail('not_on_receipt') // said "That's everything" or "I wasn't there": nothing more to ask

  const data = await loadLinesAndClaims(admin, expense.id)
  if (!data) return fail('state_failed')
  const elig = await participantEligibility(admin, trip.id, opts.userId, holdsOwnClaim(data.claims, data.lines, opts.userId), onExplicitList(expense, opts.userId))
  if (elig === 'failed') return fail('state_failed')
  if (elig === 'excluded') return fail('not_on_receipt')
  const { items, totalMinor } = personItems({ lines: data.lines, claims: data.claims, userId: opts.userId, currency })
  const fingerprint = await assignedFingerprint(items)

  const prior = await priorNotices(admin, expense.id, opts.userId)
  if (!prior) return fail('state_failed')
  const priorCount = prior.filter((r) => r.kind === RECEIPT_TABLE_KIND).length
  const markers = prior.filter((r) => r.kind === RECEIPT_TABLE_FP_KIND)
  const lastMarker = markers.length > 0 ? markers[markers.length - 1].dedupe_key : null
  const lastFingerprint = lastMarker ? lastMarker.split(':').pop() ?? null : null
  const seq = decideTableSequence({ priorCount, lastFingerprint, fingerprint, force: opts.force === true })
  if (!seq.send) return fail(seq.reason)
  if (await overCap(admin, opts.userId)) return fail('capped')

  const key = tableNoticeKey(expense.id, opts.userId, seq.n)
  if (!(await claimDedupe(admin, dedupeRow(sender, trip.id, opts.userId, expense.id, RECEIPT_TABLE_KIND, key)))) return fail('already_sent')
  const markerKey = tableFingerprintKey(expense.id, opts.userId, seq.n, fingerprint)
  // The marker remembers what this email showed. If it cannot be written the email still goes (a later change just will not re-send).
  let markerWritten = false
  try {
    markerWritten = await claimDedupe(admin, dedupeRow(sender, trip.id, opts.userId, expense.id, RECEIPT_TABLE_FP_KIND, markerKey))
  } catch {
    markerWritten = false
  }
  const release = async () => {
    await admin.from('notifications').delete().eq('dedupe_key', key)
    if (markerWritten) await admin.from('notifications').delete().eq('dedupe_key', markerKey)
  }

  try {
    const issued = await issueToken(admin, expense.id, opts.userId)
    if (!issued.ok) {
      await release()
      return fail(issued.reason)
    }
    const mail = renderClaimEmail({
      variant: items.some((i: PersonItem) => i.assigned) ? 'put_down' : 'tell_us',
      recipientFirstName: displayFirstName(recipient, 'there'),
      payerName: displayFirstName(payer),
      receiptTitle: title,
      tripName: trip.name,
      currency,
      items,
      totalMinor,
      deadlineIso: expense.claim_deadline,
      now,
      doneUrl: receiptPageUrl(opts.appBaseUrl, issued.token, 'done'),
      changeUrl: receiptPageUrl(opts.appBaseUrl, issued.token),
      notThereUrl: receiptPageUrl(opts.appBaseUrl, issued.token, 'not_there'),
      appUrl: receiptAppUrl(opts.appBaseUrl, trip.id, expense.id),
    })
    try {
      await sender.send({ toEmail: recipient.email!, toName: recipient.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
    } catch (sendError) {
      await issued.rollback() // the link never reached anyone: do not let it retire one that did
      throw sendError
    }
    return OK
  } catch (e) {
    logFailure('table notice', e)
    await release()
    return fail('send_failed')
  }
}

/** Sends the table email to each person in turn. Returns one outcome per person (the caller folds them into counts). */
export async function sendReceiptTableNotices(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { expenseId: string; userIds: string[]; actorId: string | null; appBaseUrl: string; now?: Date; resendUserIds?: ReadonlyArray<string> }
): Promise<RecipientOutcome[]> {
  const out: RecipientOutcome[] = []
  const resend = new Set(opts.resendUserIds ?? [])
  for (const userId of [...new Set([...opts.userIds, ...resend])]) {
    try {
      const r = await sendReceiptTableNotice(admin, sender, { expenseId: opts.expenseId, userId, actorId: opts.actorId, appBaseUrl: opts.appBaseUrl, now: opts.now, force: resend.has(userId) })
      out.push({ sent: r.sent, reason: r.reason })
    } catch (e) {
      logFailure('table notice', e)
      out.push({ sent: false, reason: 'state_failed' })
    }
  }
  return out
}

/**
 * The one reminder, about 24 hours before the deadline (called by the daily job). Re-checks everything: the receipt is open with a
 * deadline at most 25 hours away, the person has not answered and has not changed their own items since being put down.
 */
export async function sendReceiptReminderNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { expenseId: string; userId: string; appBaseUrl: string; now?: Date }
): Promise<ReceiptNoticeResult> {
  const now = opts.now ?? new Date()
  const ctx = await loadContext(admin, opts.expenseId, opts.userId)
  if (!ctx.ok) return fail(ctx.reason)
  const { expense, trip, payer, recipient, facts, title, currency } = ctx
  if (!recipient || !payer) return fail('not_found')

  const decision = decideReceiptNotice({
    type: 'reminder',
    receipt: facts,
    recipient: { email: recipient.email, emailNotificationsEnabled: recipient.email_notifications_enabled, channelAvailable: sender.available },
    recipientId: opts.userId,
    actorId: null,
    now,
  })
  if (!decision.send) return fail(decision.reason!)
  if (opts.userId === expense.paid_by) return fail('same_person')
  if (!(await bothOnTrip(admin, trip.id, expense.paid_by!, opts.userId))) return fail('not_found')

  const responded = await hasResponse(admin, expense.id, opts.userId)
  if (responded === null) return fail('state_failed')
  const data = await loadLinesAndClaims(admin, expense.id)
  if (!data) return fail('state_failed')
  const elig = await participantEligibility(admin, trip.id, opts.userId, holdsOwnClaim(data.claims, data.lines, opts.userId), onExplicitList(expense, opts.userId))
  if (elig === 'failed') return fail('state_failed')
  if (elig === 'excluded') return fail('not_on_receipt')
  const prior = await priorNotices(admin, expense.id, opts.userId)
  if (!prior) return fail('state_failed')
  // "Engaged" = changed their own items after the last time we told them (table email or reminder) or after the receipt was last reopened
  // (a reopen strips and rebuilds derived rows, which must not look like the person's own edit).
  const told = prior.filter((r) => r.kind === RECEIPT_TABLE_KIND || r.kind === RECEIPT_REMINDER_KIND).map((r) => r.sent_at)
  const reopenedAt = await lastReopenedAt(admin, trip.id, expense.id)
  const baseline = [...told, told.length === 0 ? expense.claims_sent_at : null, reopenedAt].reduce<string | null>(
    (best, t) => (t && (!best || Date.parse(t) > Date.parse(best)) ? t : best),
    null
  )
  const engagement = decideReminderEngagement({ hasResponse: responded, ownChangeAt: latestOwnChange(data.claims, opts.userId, data.lines), baselineAt: baseline })
  if (!engagement.send) return fail(engagement.reason!)
  const key = reminderNoticeKey(expense.id, opts.userId, expense.claim_deadline)
  const seq = decideReminderSequence({ priorKeys: prior.filter((r) => r.kind === RECEIPT_REMINDER_KIND).map((r) => r.dedupe_key), key })
  if (!seq.send) return fail(seq.reason)
  if (await overCap(admin, opts.userId)) return fail('capped')

  if (!(await claimDedupe(admin, dedupeRow(sender, trip.id, opts.userId, expense.id, RECEIPT_REMINDER_KIND, key)))) return fail('already_sent')
  const release = () => admin.from('notifications').delete().eq('dedupe_key', key)

  try {
    const issued = await issueToken(admin, expense.id, opts.userId)
    if (!issued.ok) {
      await release()
      return fail(issued.reason)
    }
    const { items, totalMinor } = personItems({ lines: data.lines, claims: data.claims, userId: opts.userId, currency })
    const mail = renderClaimEmail({
      variant: 'reminder',
      recipientFirstName: displayFirstName(recipient, 'there'),
      payerName: displayFirstName(payer),
      receiptTitle: title,
      tripName: trip.name,
      currency,
      items,
      totalMinor,
      deadlineIso: expense.claim_deadline,
      now,
      doneUrl: receiptPageUrl(opts.appBaseUrl, issued.token, 'done'),
      changeUrl: receiptPageUrl(opts.appBaseUrl, issued.token),
      notThereUrl: receiptPageUrl(opts.appBaseUrl, issued.token, 'not_there'),
      appUrl: receiptAppUrl(opts.appBaseUrl, trip.id, expense.id),
    })
    try {
      await sender.send({ toEmail: recipient.email!, toName: recipient.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
    } catch (sendError) {
      await issued.rollback()
      throw sendError
    }
    return OK
  } catch (e) {
    logFailure('reminder', e)
    await release()
    return fail('send_failed')
  }
}

/**
 * "The deadline passed — £3.00 of unclaimed items from <Receipt> was added to your share (now £45.00)". Called by the daily job after
 * apply_receipt_deadline returned applied:true. Amounts are in MINOR units. Nothing is sent for a person charged nothing. No token:
 * the link is the in-app receipt. Once per person per receipt; after a reopen and a second close, once more only if the amount changed (cap 2).
 */
export async function sendReceiptResultNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { expenseId: string; userId: string; leftoverAmountMinor: number; totalMinor: number; appBaseUrl: string; now?: Date }
): Promise<ReceiptNoticeResult> {
  const now = opts.now ?? new Date()
  if (!Number.isInteger(opts.leftoverAmountMinor) || !Number.isInteger(opts.totalMinor) || opts.leftoverAmountMinor <= 0) return fail('zero_amount')
  const ctx = await loadContext(admin, opts.expenseId, opts.userId)
  if (!ctx.ok) return fail(ctx.reason)
  const { expense, trip, recipient, facts, title, currency } = ctx
  if (!recipient || !expense.paid_by) return fail('not_found')

  const decision = decideReceiptNotice({
    type: 'result',
    receipt: facts,
    recipient: { email: recipient.email, emailNotificationsEnabled: recipient.email_notifications_enabled, channelAvailable: sender.available },
    recipientId: opts.userId,
    actorId: null,
    now,
  })
  if (!decision.send) return fail(decision.reason!)
  if (opts.userId === expense.paid_by) return fail('same_person')
  if (!(await bothOnTrip(admin, trip.id, expense.paid_by, opts.userId))) return fail('not_found')
  if ((await participantEligibility(admin, trip.id, opts.userId, false, onExplicitList(expense, opts.userId))) !== 'ok') return fail('not_on_receipt')
  const response = await responseOf(admin, expense.id, opts.userId)
  if (response === null) return fail('state_failed')

  // Once per close; after a reopen and a second close only if the person's leftover amount changed (at most 2 per receipt).
  const prior = await priorNotices(admin, expense.id, opts.userId)
  if (!prior) return fail('state_failed')
  const seq = decideResultSequence({ priorKeys: prior.filter((r) => r.kind === RECEIPT_RESULT_KIND).map((r) => r.dedupe_key), leftoverMinor: opts.leftoverAmountMinor })
  if (!seq.send) return fail(seq.reason)
  if (await overCap(admin, opts.userId)) return fail('capped')

  const key = resultNoticeKey(expense.id, opts.userId, opts.leftoverAmountMinor)
  if (!(await claimDedupe(admin, dedupeRow(sender, trip.id, opts.userId, expense.id, RECEIPT_RESULT_KIND, key)))) return fail('already_sent')
  const release = () => admin.from('notifications').delete().eq('dedupe_key', key)

  try {
    const mail = renderResultEmail({
      recipientFirstName: displayFirstName(recipient, 'there'),
      receiptTitle: title,
      tripName: trip.name,
      currency,
      leftoverMinor: opts.leftoverAmountMinor,
      totalMinor: opts.totalMinor,
      recipientConfirmed: response === 'done',
      closedEarly: closedEarly(expense.claim_deadline, expense.claims_closed_at),
      appUrl: receiptAppUrl(opts.appBaseUrl, trip.id, expense.id),
    })
    await sender.send({ toEmail: recipient.email!, toName: recipient.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
    return OK
  } catch (e) {
    logFailure('result notice', e)
    await release()
    return fail('send_failed')
  }
}
