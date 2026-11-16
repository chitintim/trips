/**
 * The I/O half of the payment notice emails. Callers (payment-notice,
 * payment-confirm) have ALREADY authorised the request; everything else is
 * re-checked here against the database with the service-role client:
 * settlement status, parties, email gates, dedupe.
 *
 * Dedupe: a `notifications` row (unique dedupe_key) is inserted BEFORE the
 * send, so two concurrent calls send once. If the send then fails the row is
 * deleted so a retry can send; gate skips write nothing.
 */

/**
 * The slice of the supabase-js client these senders use. Structural (and loosely typed) on purpose:
 * the unit tests pass an in-memory fake and the module imports nothing that needs npm resolution.
 */
// deno-lint-ignore no-explicit-any
type Query = any
export interface SupabaseClient {
  from(table: string): Query
  rpc(fn: string, args: Record<string, unknown>): Query
}
import type { EmailSender } from './emailSender.ts'
import {
  CONFIRMED_NOTICE_KIND,
  DISPUTED_NOTICE_KIND,
  PAID_NOTICE_KIND,
  confirmedNoticeKey,
  decideConfirmedNotice,
  decideDisputedNotice,
  decidePaidNotice,
  disputedNoticeKey,
  overDailyCap,
  renderDisputedNotice,
  displayFirstName,
  isPayerSquare,
  paidNoticeKey,
  confirmPageUrl,
  paymentAppUrl,
  renderConfirmedNotice,
  renderPaidNotice,
  tripUrl,
  type NoticeSkipReason,
} from './paymentNoticeCore.ts'
import { generateToken, hashToken } from './paymentToken.ts'

export type NoticeResult = { sent: true; reason: null } | { sent: false; reason: NoticeSkipReason | 'not_found' | 'already_sent' | 'send_failed' | 'token_failed' | 'capped' }

interface SettlementRow {
  id: string
  trip_id: string
  from_user_id: string
  to_user_id: string
  amount: number
  currency: string | null
  status: string
  notes: string | null
}

interface UserRow {
  id: string
  email: string | null
  full_name: string | null
  first_name: string | null
  email_notifications_enabled: boolean | null
}

const USER_COLS = 'id, email, full_name, first_name, email_notifications_enabled'

async function loadContext(admin: SupabaseClient, settlementId: string) {
  const { data: s } = await admin
    .from('settlements')
    .select('id, trip_id, from_user_id, to_user_id, amount, currency, status, notes')
    .eq('id', settlementId)
    .maybeSingle()
  if (!s) return null
  const settlement = s as SettlementRow
  const [{ data: trip }, { data: users }] = await Promise.all([
    admin.from('trips').select('id, name, base_currency, settlement_snapshot').eq('id', settlement.trip_id).maybeSingle(),
    admin.from('users').select(USER_COLS).in('id', [settlement.from_user_id, settlement.to_user_id]),
  ])
  if (!trip) return null
  const byId = new Map(((users ?? []) as UserRow[]).map((u) => [u.id, u]))
  return {
    settlement,
    trip: trip as { id: string; name: string; base_currency: string; settlement_snapshot: unknown },
    payer: byId.get(settlement.from_user_id),
    receiver: byId.get(settlement.to_user_id),
  }
}

/** Insert the dedupe row; false when it already exists (someone else sent, or is sending). */
async function claimDedupe(admin: SupabaseClient, row: Record<string, unknown>): Promise<boolean> {
  const { error } = await admin.from('notifications').insert(row)
  if (!error) return true
  if (error.code === '23505' || /duplicate/i.test(error.message ?? '')) return false
  throw new Error('notification insert failed')
}

/**
 * Both people must have a trip_participants row for this payment's trip. (A person who has left can
 * still be owed or owe, so an inactive row counts.) Stops anyone mailing a user who is not on the trip
 * the payment claims to be about, which the settlements INSERT policy alone does not prevent.
 */
async function bothOnTrip(admin: SupabaseClient, tripId: string, a: string, b: string): Promise<boolean> {
  const { data } = await admin.from('trip_participants').select('user_id').eq('trip_id', tripId).in('user_id', [a, b])
  const ids = new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))
  return ids.has(a) && ids.has(b)
}

/** True when `userId` has already been sent the daily maximum of this kind. A count error counts as over. */
async function overCap(admin: SupabaseClient, userId: string, kind: string): Promise<boolean> {
  const since = new Date(Date.now() - 864e5).toISOString()
  const { count } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('sent_at', since)
  return overDailyCap(count)
}

/** The receiver's "X paid you" email. `actorId` is the (already authorised) caller. */
export async function sendPaidNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { settlementId: string; actorId: string; appBaseUrl: string }
): Promise<NoticeResult> {
  const ctx = await loadContext(admin, opts.settlementId)
  if (!ctx || !ctx.payer || !ctx.receiver) return { sent: false, reason: 'not_found' }
  const { settlement: s, trip, payer, receiver } = ctx

  const decision = decidePaidNotice({
    status: s.status,
    payerId: s.from_user_id,
    receiverId: s.to_user_id,
    callerId: opts.actorId,
    receiver: { email: receiver.email, emailNotificationsEnabled: receiver.email_notifications_enabled, channelAvailable: sender.available },
  })
  if (!decision.send) return { sent: false, reason: decision.reason! }
  if (!(await bothOnTrip(admin, trip.id, s.from_user_id, s.to_user_id))) return { sent: false, reason: 'not_found' }
  if (await overCap(admin, s.to_user_id, PAID_NOTICE_KIND)) return { sent: false, reason: 'capped' }

  const dedupeKey = paidNoticeKey(s.id, s.to_user_id)
  const claimed = await claimDedupe(admin, {
    trip_id: trip.id,
    user_id: s.to_user_id,
    kind: PAID_NOTICE_KIND,
    entity_type: 'settlement',
    entity_id: s.id,
    channel: sender.channel,
    dedupe_key: dedupeKey,
  })
  if (!claimed) return { sent: false, reason: 'already_sent' }

  const release = () => admin.from('notifications').delete().eq('dedupe_key', dedupeKey)
  try {
    const token = generateToken()
    const { data: issued, error: issueError } = await admin.rpc('issue_payment_confirm_token', {
      p_settlement_id: s.id,
      p_token_hash: await hashToken(token),
    })
    if (issueError || (issued as { result?: string } | null)?.result !== 'issued') {
      await release()
      return { sent: false, reason: 'token_failed' }
    }

    const payerName = displayFirstName(payer)
    const recordedByName = opts.actorId === s.from_user_id ? null : await actorName(admin, opts.actorId)
    const currency = s.currency || trip.base_currency
    const mail = renderPaidNotice({
      receiverFirstName: displayFirstName(receiver, 'there'),
      payerName,
      recordedByName,
      amount: Number(s.amount),
      currency,
      tripName: trip.name,
      note: s.notes,
      confirmUrl: confirmPageUrl(opts.appBaseUrl, token),
      appUrl: paymentAppUrl(opts.appBaseUrl, trip.id, s.id),
    })
    await sender.send({ toEmail: receiver.email!, toName: receiver.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })

    // So the payer and organisers can see it went out (notifications is not readable by the payer).
    await admin.from('activity_feed').insert({
      trip_id: trip.id,
      actor: opts.actorId,
      verb: 'settlement_receipt_requested',
      entity: { type: 'settlement', id: s.id, label: `${payerName} → ${displayFirstName(receiver)}` },
      metadata: { receiver_id: s.to_user_id, receiver_name: displayFirstName(receiver), payer_name: payerName, sent_at: new Date().toISOString() },
    })
    return { sent: true, reason: null }
  } catch (e) {
    console.error('[payment-notice] paid notice failed:', e instanceof Error ? e.message.slice(0, 200) : 'unknown')
    await release()
    return { sent: false, reason: 'send_failed' }
  }
}

async function actorName(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.from('users').select('first_name, full_name').eq('id', userId).maybeSingle()
  return displayFirstName(data as { first_name: string | null; full_name: string | null } | null, 'An organizer')
}

/** The payer's "X confirmed your £Y" email. The caller has verified the receiver confirmed it themself. */
export async function sendConfirmedNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { settlementId: string; appBaseUrl: string }
): Promise<NoticeResult> {
  const ctx = await loadContext(admin, opts.settlementId)
  if (!ctx || !ctx.payer || !ctx.receiver) return { sent: false, reason: 'not_found' }
  const { settlement: s, trip, payer, receiver } = ctx

  const decision = decideConfirmedNotice({
    status: s.status,
    payerId: s.from_user_id,
    receiverId: s.to_user_id,
    payer: { email: payer.email, emailNotificationsEnabled: payer.email_notifications_enabled, channelAvailable: sender.available },
  })
  if (!decision.send) return { sent: false, reason: decision.reason! }
  if (!(await bothOnTrip(admin, trip.id, s.from_user_id, s.to_user_id))) return { sent: false, reason: 'not_found' }
  if (await overCap(admin, s.from_user_id, CONFIRMED_NOTICE_KIND)) return { sent: false, reason: 'capped' }

  const dedupeKey = confirmedNoticeKey(s.id, s.from_user_id)
  const claimed = await claimDedupe(admin, {
    trip_id: trip.id,
    user_id: s.from_user_id,
    kind: CONFIRMED_NOTICE_KIND,
    entity_type: 'settlement',
    entity_id: s.id,
    channel: sender.channel,
    dedupe_key: dedupeKey,
  })
  if (!claimed) return { sent: false, reason: 'already_sent' }

  try {
    const payerNotes = `from_user_id.eq.${s.from_user_id},to_user_id.eq.${s.from_user_id}`
    const [others, carryovers] = await Promise.all([
      admin
        .from('settlements')
        .select('id', { count: 'exact', head: true })
        .eq('trip_id', trip.id)
        .neq('status', 'confirmed')
        .neq('id', s.id)
        .or(payerNotes),
      admin
        .from('settlement_carryovers')
        .select('id', { count: 'exact', head: true })
        .or(`trip_id.eq.${trip.id},source_trip_id.eq.${trip.id}`)
        .or(payerNotes),
    ])
    const mail = renderConfirmedNotice({
      payerFirstName: displayFirstName(payer, 'there'),
      receiverName: displayFirstName(receiver),
      amount: Number(s.amount),
      currency: s.currency || trip.base_currency,
      tripName: trip.name,
      square: isPayerSquare({ tripFrozen: !!trip.settlement_snapshot, otherUnfinishedPaymentsByPayer: others.count ?? null, carryoversInvolvingPayer: carryovers.count ?? null }),
      tripUrl: tripUrl(opts.appBaseUrl, trip.id),
    })
    await sender.send({ toEmail: payer.email!, toName: payer.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
    return { sent: true, reason: null }
  } catch (e) {
    console.error('[payment-notice] confirmed notice failed:', e instanceof Error ? e.message.slice(0, 200) : 'unknown')
    await admin.from('notifications').delete().eq('dedupe_key', dedupeKey)
    return { sent: false, reason: 'send_failed' }
  }
}

/**
 * The payer's "<Receiver> says they haven't received your £X yet" email, sent by payment-confirm right
 * after the receiver pressed "I haven't received it" on the confirm page. Same gates as the other
 * notices; only while the payment is still marked_paid.
 */
export async function sendDisputedNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { settlementId: string; appBaseUrl: string }
): Promise<NoticeResult> {
  const ctx = await loadContext(admin, opts.settlementId)
  if (!ctx || !ctx.payer || !ctx.receiver) return { sent: false, reason: 'not_found' }
  const { settlement: s, trip, payer, receiver } = ctx

  const decision = decideDisputedNotice({
    status: s.status,
    payerId: s.from_user_id,
    receiverId: s.to_user_id,
    payer: { email: payer.email, emailNotificationsEnabled: payer.email_notifications_enabled, channelAvailable: sender.available },
  })
  if (!decision.send) return { sent: false, reason: decision.reason! }
  if (!(await bothOnTrip(admin, trip.id, s.from_user_id, s.to_user_id))) return { sent: false, reason: 'not_found' }
  if (await overCap(admin, s.from_user_id, DISPUTED_NOTICE_KIND)) return { sent: false, reason: 'capped' }

  const dedupeKey = disputedNoticeKey(s.id, s.from_user_id)
  const claimed = await claimDedupe(admin, {
    trip_id: trip.id,
    user_id: s.from_user_id,
    kind: DISPUTED_NOTICE_KIND,
    entity_type: 'settlement',
    entity_id: s.id,
    channel: sender.channel,
    dedupe_key: dedupeKey,
  })
  if (!claimed) return { sent: false, reason: 'already_sent' }

  try {
    const mail = renderDisputedNotice({
      payerFirstName: displayFirstName(payer, 'there'),
      receiverName: displayFirstName(receiver),
      amount: Number(s.amount),
      currency: s.currency || trip.base_currency,
      tripName: trip.name,
      tripUrl: tripUrl(opts.appBaseUrl, trip.id),
    })
    await sender.send({ toEmail: payer.email!, toName: payer.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
    return { sent: true, reason: null }
  } catch (e) {
    console.error('[payment-confirm] disputed notice failed:', e instanceof Error ? e.message.slice(0, 200) : 'unknown')
    await admin.from('notifications').delete().eq('dedupe_key', dedupeKey)
    return { sent: false, reason: 'send_failed' }
  }
}
