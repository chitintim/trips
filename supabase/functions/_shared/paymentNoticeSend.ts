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
  REASK_NOTICE_KIND,
  RETRACTED_NOTICE_KIND,
  canManageTripFacts,
  confirmedNoticeKey,
  decideConfirmedNotice,
  decideDisputedNotice,
  decideDisputedRound,
  decidePaidNotice,
  decidePaidSequence,
  decideReAsk,
  decideRetractedSequence,
  disputedNoticeKey,
  latestIso,
  overDailyCap,
  recipientDecision,
  renderDisputedNotice,
  renderReAskNotice,
  renderRetractedNotice,
  retractedNoticeKey,
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

export type NoticeResult =
  | { sent: true; reason: null }
  | { sent: false; reason: NoticeSkipReason | 'not_found' | 'send_failed' | 'token_failed' | 'clear_failed' | 'state_failed' }

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
export async function claimDedupe(admin: SupabaseClient, row: Record<string, unknown>): Promise<boolean> {
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
export async function bothOnTrip(admin: SupabaseClient, tripId: string, a: string, b: string): Promise<boolean> {
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


// ---------------------------------------------------------------------------
// Counting what was already sent (notifications = the unspoofable record) and the
// activity rows the functions themselves wrote (retractions, re-asks, disputes).
// ---------------------------------------------------------------------------

const RETRACTED_VERB = 'settlement_retracted'
const RE_ASKED_VERB = 'settlement_re_asked'
const DISPUTED_VERB = 'settlement_receipt_disputed'
const PAID_TYPE_KINDS = [PAID_NOTICE_KIND, REASK_NOTICE_KIND]

/** sent_at of every notification of these kinds for this payment. */
async function noticeTimes(admin: SupabaseClient, settlementId: string, kinds: string[]): Promise<Array<{ kind: string; at: string }>> {
  const { data } = await admin.from('notifications').select('kind, sent_at').eq('entity_id', settlementId).in('kind', kinds)
  return ((data ?? []) as Array<{ kind: string; sent_at: string | null }>).map((r) => ({ kind: r.kind, at: r.sent_at ?? new Date(0).toISOString() }))
}

/** Can this user manage the trip (site admin, ACTIVE organiser, trip creator)? */
export async function userCanManageTrip(admin: SupabaseClient, tripId: string, userId: string): Promise<boolean> {
  const [{ data: u }, { data: org }, { data: trip }] = await Promise.all([
    admin.from('users').select('role').eq('id', userId).maybeSingle(),
    admin.from('trip_participants').select('user_id').eq('trip_id', tripId).eq('user_id', userId).eq('role', 'organizer').eq('active', true).maybeSingle(),
    admin.from('trips').select('created_by').eq('id', tripId).maybeSingle(),
  ])
  return canManageTripFacts({ isSiteAdmin: u?.role === 'admin', isActiveOrganizer: !!org, isTripCreator: trip?.created_by === userId })
}

/**
 * Activity rows this payment has for `verb`, kept only when their actor fits the claim (anyone on the trip can insert
 * activity rows with other actors): the payer or a trip manager for retractions and re-asks, the receiver for disputes.
 */
async function trustedActivityTimes(
  admin: SupabaseClient,
  s: { id: string; trip_id: string; from_user_id: string; to_user_id: string },
  verb: string,
  who: 'payer_or_manager' | 'receiver'
): Promise<string[]> {
  const { data } = await admin.from('activity_feed').select('actor, created_at').eq('verb', verb).eq('entity->>id', s.id)
  const rows = ((data ?? []) as Array<{ actor: string | null; created_at: string | null }>).filter((r) => r.actor && r.created_at)
  const trust = new Map<string, boolean>()
  for (const r of rows) {
    const a = r.actor!
    if (trust.has(a)) continue
    trust.set(a, who === 'receiver' ? a === s.to_user_id : a === s.from_user_id || (await userCanManageTrip(admin, s.trip_id, a)))
  }
  return rows.filter((r) => trust.get(r.actor!)).map((r) => r.created_at!)
}

/** PostgREST / Postgres "that column does not exist" (the migration has not been applied yet). */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42703' || error.code === 'PGRST204' || /column .*does not exist|could not find .* column/i.test(error.message ?? ''))
}

/**
 * `{supported:false}` when the column does not exist yet (the whole dispute feature then stays dormant).
 * `{failed:true}` for any OTHER error (a transient failure must never look like "not supported": the caller answers 502).
 */
async function loadDisputeFlag(admin: SupabaseClient, settlementId: string): Promise<{ supported: boolean; disputed: boolean; failed?: boolean }> {
  const { data, error } = await admin.from('settlements').select('receipt_disputed_at').eq('id', settlementId).maybeSingle()
  if (error) return isMissingColumn(error) ? { supported: false, disputed: false } : { supported: false, disputed: false, failed: true }
  if (!data) return { supported: false, disputed: false }
  return { supported: true, disputed: !!(data as { receipt_disputed_at: string | null }).receipt_disputed_at }
}

/** settlements.last_retracted_at: stamped by the database guard whenever the payment goes marked_paid -> suggested. */
async function loadLastRetractedAt(admin: SupabaseClient, settlementId: string): Promise<{ supported: boolean; at: string | null; failed?: boolean }> {
  const { data, error } = await admin.from('settlements').select('last_retracted_at').eq('id', settlementId).maybeSingle()
  if (error) return isMissingColumn(error) ? { supported: false, at: null } : { supported: false, at: null, failed: true }
  if (!data) return { supported: false, at: null }
  return { supported: true, at: (data as { last_retracted_at: string | null }).last_retracted_at ?? null }
}

async function writeActivity(admin: SupabaseClient, row: Record<string, unknown>) {
  try {
    await admin.from('activity_feed').insert(row)
  } catch {
    /* an audit row must never break a notice */
  }
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
  const paidTimes = (await noticeTimes(admin, s.id, PAID_TYPE_KINDS)).map((r) => r.at)
  // The boundary of "a new round" is the database's own stamp (never a client-written row). An unknown boundary sends nothing.
  const retract = await loadLastRetractedAt(admin, s.id)
  if (retract.failed) return { sent: false, reason: 'state_failed' }
  const seq = decidePaidSequence({ paidTypeTimes: paidTimes, lastRetractAt: retract.at })
  if (!seq.send) return { sent: false, reason: seq.reason }
  if (await overCap(admin, s.to_user_id, PAID_NOTICE_KIND)) return { sent: false, reason: 'capped' }

  const dedupeKey = paidNoticeKey(s.id, s.to_user_id, seq.n)
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
      confirmYesUrl: confirmPageUrl(opts.appBaseUrl, token, 'yes'),
      confirmNoUrl: confirmPageUrl(opts.appBaseUrl, token, 'no'),
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
 * The payer's "<Receiver> says they haven't received your £X yet" email, sent after the receiver said "not received"
 * (on the confirm page via payment-confirm, or in the app via payment-notice 'disputed'). Same gates as the other
 * notices; only while the payment is still marked_paid; ONE per dispute round (a round starts at each paid / re-ask
 * notice) and at most DISPUTED_PER_PAYMENT_CAP per payment.
 *
 * `requireFlag` (the in-app path): the caller has not proved the receiver disputed it, so the row's
 * receipt_disputed_at must be set (a database without the column sends nothing).
 * `activityActorId`: also write the `settlement_receipt_disputed` activity row (the token flow's RPC already does).
 */
export async function sendDisputedNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { settlementId: string; appBaseUrl: string; requireFlag?: boolean; activityActorId?: string }
): Promise<NoticeResult> {
  const ctx = await loadContext(admin, opts.settlementId)
  if (!ctx || !ctx.payer || !ctx.receiver) return { sent: false, reason: 'not_found' }
  const { settlement: s, trip, payer, receiver } = ctx

  if (opts.requireFlag) {
    const flag = await loadDisputeFlag(admin, s.id)
    if (flag.failed) return { sent: false, reason: 'state_failed' }
    if (!flag.supported || !flag.disputed) return { sent: false, reason: 'not_disputed' }
  }
  const decision = decideDisputedNotice({
    status: s.status,
    payerId: s.from_user_id,
    receiverId: s.to_user_id,
    payer: { email: payer.email, emailNotificationsEnabled: payer.email_notifications_enabled, channelAvailable: sender.available },
  })
  if (!decision.send) return { sent: false, reason: decision.reason! }
  if (!(await bothOnTrip(admin, trip.id, s.from_user_id, s.to_user_id))) return { sent: false, reason: 'not_found' }

  const paidTimes = (await noticeTimes(admin, s.id, PAID_TYPE_KINDS)).map((r) => r.at)
  const disputedTimes = (await noticeTimes(admin, s.id, [DISPUTED_NOTICE_KIND])).map((r) => r.at)
  const round = decideDisputedRound({ disputedTimes, paidTypeTimes: paidTimes })

  if (opts.activityActorId) {
    // One activity row per round, so a repeated tap does not stack lines.
    const boundary = latestIso(paidTimes)
    const seen = (await trustedActivityTimes(admin, s, DISPUTED_VERB, 'receiver')).filter((t) => boundary === null || new Date(t).getTime() > new Date(boundary).getTime())
    if (seen.length === 0) {
      await writeActivity(admin, {
        trip_id: trip.id,
        actor: opts.activityActorId,
        verb: DISPUTED_VERB,
        entity: { type: 'settlement', id: s.id, label: `${displayFirstName(payer)} → ${displayFirstName(receiver)}` },
        metadata: { payer_id: s.from_user_id, receiver_id: s.to_user_id, amount: Number(s.amount), currency: s.currency || trip.base_currency, via: 'app' },
      })
    }
  }
  if (!round.send) return { sent: false, reason: round.reason }
  if (await overCap(admin, s.from_user_id, DISPUTED_NOTICE_KIND)) return { sent: false, reason: 'capped' }

  const dedupeKey = disputedNoticeKey(s.id, s.from_user_id, round.n)
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

/**
 * "Ask again": the payer (or an organiser) says "I've sent it" after the receiver said it had not arrived.
 * The CALLER has authorised the actor. Order (D4): checks, dedupe claim, then ONE atomic database call that clears the
 * flag AND issues the fresh link (clear_receipt_dispute), THEN the email. A receiver who taps "No" on the fresh link
 * the moment it arrives can therefore never have that answer wiped by a late clear. If the email cannot be sent the
 * flag is put back (restore_receipt_dispute) and the fresh link retired, so a retry is possible and nothing is lost.
 *
 * If the receiver cannot be emailed at all (switch off, no address, no provider) the flag is still cleared so the
 * payer is not stuck and the receiver's to-do comes back; that is a silent success for the caller. If the email WOULD
 * be blocked by a cap (daily cap, or the shared paid/re-ask sequence is full) nothing changes and the answer is 'capped'.
 * A database without the columns does nothing at all.
 */
export async function sendReAskNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { settlementId: string; actorId: string; appBaseUrl: string }
): Promise<NoticeResult> {
  const ctx = await loadContext(admin, opts.settlementId)
  if (!ctx || !ctx.payer || !ctx.receiver) return { sent: false, reason: 'not_found' }
  const { settlement: s, trip, payer, receiver } = ctx

  const flag = await loadDisputeFlag(admin, s.id)
  if (flag.failed) return { sent: false, reason: 'state_failed' }
  if (!flag.supported) return { sent: false, reason: 'not_disputed' }
  if (!(await bothOnTrip(admin, trip.id, s.from_user_id, s.to_user_id))) return { sent: false, reason: 'not_found' }

  const paidRows = await noticeTimes(admin, s.id, PAID_TYPE_KINDS)
  const reAskActivity = await trustedActivityTimes(admin, s, RE_ASKED_VERB, 'payer_or_manager')
  const reAsksUsed = Math.max(paidRows.filter((r) => r.kind === REASK_NOTICE_KIND).length, reAskActivity.length)
  const rule = decideReAsk({ status: s.status, disputed: flag.disputed, payerId: s.from_user_id, receiverId: s.to_user_id, reAsksUsed, paidTypeCount: paidRows.length })
  if (!rule.allowed) return { sent: false, reason: rule.reason }

  const rpcClear = async (tokenHash: string | null): Promise<'cleared' | 'not_disputed' | 'not_marked_paid' | 'token_failed' | 'failed'> => {
    const { data, error } = await admin.rpc('clear_receipt_dispute', tokenHash ? { p_settlement_id: s.id, p_token_hash: tokenHash } : { p_settlement_id: s.id })
    if (error) {
      console.error('[payment-notice] clear dispute failed')
      return 'failed'
    }
    const result = (data as { result?: string } | null)?.result
    return result === 'cleared' || result === 'not_disputed' || result === 'not_marked_paid' || result === 'token_failed' ? result : 'failed'
  }
  const label = `${displayFirstName(payer)} → ${displayFirstName(receiver)}`
  const logActivity = (emailed: boolean) =>
    writeActivity(admin, {
      trip_id: trip.id,
      actor: opts.actorId,
      verb: RE_ASKED_VERB,
      entity: { type: 'settlement', id: s.id, label },
      metadata: { receiver_id: s.to_user_id, emailed },
    })

  const gate = recipientDecision({ email: receiver.email, emailNotificationsEnabled: receiver.email_notifications_enabled, channelAvailable: sender.available })
  if (!gate.send) {
    // No email can go out. Still unblock the payer: clear the flag and record the re-ask (it counts toward the cap of 2).
    const cleared = await rpcClear(null)
    if (cleared === 'not_disputed' || cleared === 'not_marked_paid') return { sent: false, reason: cleared === 'not_disputed' ? 'not_disputed' : 'not_marked_paid' }
    if (cleared !== 'cleared') return { sent: false, reason: 'clear_failed' }
    await logActivity(false)
    return { sent: false, reason: gate.reason! }
  }
  if (rule.n === null || (await overCap(admin, s.to_user_id, REASK_NOTICE_KIND))) return { sent: false, reason: 'capped' }

  const dedupeKey = paidNoticeKey(s.id, s.to_user_id, rule.n)
  const claimed = await claimDedupe(admin, {
    trip_id: trip.id,
    user_id: s.to_user_id,
    kind: REASK_NOTICE_KIND,
    entity_type: 'settlement',
    entity_id: s.id,
    channel: sender.channel,
    dedupe_key: dedupeKey,
  })
  if (!claimed) return { sent: false, reason: 'already_sent' }

  const release = () => admin.from('notifications').delete().eq('dedupe_key', dedupeKey)
  const token = generateToken()
  const cleared = await rpcClear(await hashToken(token))
  if (cleared !== 'cleared') {
    await release()
    return { sent: false, reason: cleared === 'not_disputed' ? 'not_disputed' : cleared === 'not_marked_paid' ? 'not_marked_paid' : cleared === 'token_failed' ? 'token_failed' : 'clear_failed' }
  }

  try {
    const mail = renderReAskNotice({
      receiverFirstName: displayFirstName(receiver, 'there'),
      payerName: displayFirstName(payer),
      recordedByName: null,
      amount: Number(s.amount),
      currency: s.currency || trip.base_currency,
      tripName: trip.name,
      note: s.notes,
      confirmYesUrl: confirmPageUrl(opts.appBaseUrl, token, 'yes'),
      confirmNoUrl: confirmPageUrl(opts.appBaseUrl, token, 'no'),
      appUrl: paymentAppUrl(opts.appBaseUrl, trip.id, s.id),
    })
    await sender.send({ toEmail: receiver.email!, toName: receiver.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
  } catch (e) {
    console.error('[payment-notice] re-ask notice failed:', e instanceof Error ? e.message.slice(0, 200) : 'unknown')
    // The email did not go: put the receiver's "not received" back and retire the link nobody got, so a retry works.
    const { error: restoreError } = await admin.rpc('restore_receipt_dispute', { p_settlement_id: s.id })
    if (restoreError) console.error('[payment-notice] re-ask email failed and the flag could not be restored')
    await release()
    return { sent: false, reason: 'send_failed' }
  }

  await Promise.all([
    logActivity(true),
    writeActivity(admin, {
      trip_id: trip.id,
      actor: opts.actorId,
      verb: 'settlement_receipt_requested',
      entity: { type: 'settlement', id: s.id, label },
      metadata: { receiver_id: s.to_user_id, receiver_name: displayFirstName(receiver), payer_name: displayFirstName(payer), sent_at: new Date().toISOString(), re_ask: true },
    }),
  ])
  return { sent: true, reason: null }
}

/**
 * "<Payer> hasn't paid the £X yet": the payment went back from marked_paid to suggested (its tokens were retired by the
 * database trigger, and the database guard stamped settlements.last_retracted_at). The BOUNDARY for the next paid
 * notice is that stamp, so it does not depend on this call at all; this call only sends the courtesy email, and only
 * if the stamp is recent and no retracted email exists for that retraction. A feed line ("took back marked as paid")
 * is written once per retraction, for display only.
 */
export async function sendRetractedNotice(
  admin: SupabaseClient,
  sender: EmailSender,
  opts: { settlementId: string; actorId: string; appBaseUrl: string }
): Promise<NoticeResult> {
  const ctx = await loadContext(admin, opts.settlementId)
  if (!ctx || !ctx.payer || !ctx.receiver) return { sent: false, reason: 'not_found' }
  const { settlement: s, trip, payer, receiver } = ctx
  if (s.status !== 'suggested') return { sent: false, reason: 'not_suggested' }
  if (s.from_user_id === s.to_user_id) return { sent: false, reason: 'same_person' }
  if (!(await bothOnTrip(admin, trip.id, s.from_user_id, s.to_user_id))) return { sent: false, reason: 'not_found' }

  const retract = await loadLastRetractedAt(admin, s.id)
  if (retract.failed) return { sent: false, reason: 'state_failed' }
  const paidTimes = (await noticeTimes(admin, s.id, PAID_TYPE_KINDS)).map((r) => r.at)
  const retractedTimes = (await noticeTimes(admin, s.id, [RETRACTED_NOTICE_KIND])).map((r) => r.at)
  const rule = decideRetractedSequence({ status: s.status, paidTypeTimes: paidTimes, retractedTimes, lastRetractedAt: retract.at })
  if (!rule.send && (rule.reason === 'never_notified' || rule.reason === 'not_retracted' || rule.reason === 'retract_stale')) return { sent: false, reason: rule.reason }

  // Display only: one feed line per retraction (the legitimate boundary is the database stamp, not this row).
  const stamp = retract.at ? new Date(retract.at).getTime() : 0
  const seen = (await trustedActivityTimes(admin, s, RETRACTED_VERB, 'payer_or_manager')).filter((t) => new Date(t).getTime() >= stamp)
  if (seen.length === 0) {
    await writeActivity(admin, {
      trip_id: trip.id,
      actor: opts.actorId,
      verb: RETRACTED_VERB,
      entity: { type: 'settlement', id: s.id, label: `${displayFirstName(payer)} → ${displayFirstName(receiver)}` },
      metadata: { receiver_id: s.to_user_id, payer_id: s.from_user_id },
    })
  }
  if (!rule.send) return { sent: false, reason: rule.reason }

  const gate = recipientDecision({ email: receiver.email, emailNotificationsEnabled: receiver.email_notifications_enabled, channelAvailable: sender.available })
  if (!gate.send) return { sent: false, reason: gate.reason! }
  if (await overCap(admin, s.to_user_id, RETRACTED_NOTICE_KIND)) return { sent: false, reason: 'capped' }

  const dedupeKey = retractedNoticeKey(s.id, s.to_user_id, rule.n)
  const claimed = await claimDedupe(admin, {
    trip_id: trip.id,
    user_id: s.to_user_id,
    kind: RETRACTED_NOTICE_KIND,
    entity_type: 'settlement',
    entity_id: s.id,
    channel: sender.channel,
    dedupe_key: dedupeKey,
  })
  if (!claimed) return { sent: false, reason: 'already_sent' }

  try {
    const mail = renderRetractedNotice({
      receiverFirstName: displayFirstName(receiver, 'there'),
      payerName: displayFirstName(payer),
      amount: Number(s.amount),
      currency: s.currency || trip.base_currency,
      tripName: trip.name,
      tripUrl: tripUrl(opts.appBaseUrl, trip.id),
    })
    await sender.send({ toEmail: receiver.email!, toName: receiver.full_name ?? undefined, subject: mail.subject, text: mail.text, html: mail.html })
    return { sent: true, reason: null }
  } catch (e) {
    console.error('[payment-notice] retracted notice failed:', e instanceof Error ? e.message.slice(0, 200) : 'unknown')
    await admin.from('notifications').delete().eq('dedupe_key', dedupeKey)
    return { sent: false, reason: 'send_failed' }
  }
}
