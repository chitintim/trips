/**
 * Pure rules for the two payment notice emails and the confirm-by-email page.
 * No I/O here (see paymentNoticeSend.ts for the part that talks to Supabase),
 * so every gate, state and string is unit-testable.
 *
 *  - "paid" notice: to the RECEIVER when a payment becomes marked_paid:
 *    "<Payer> paid you £X" with a button to confirm receipt.
 *  - "confirmed" notice: to the PAYER when the receiver themself confirms.
 *  - "disputed" notice: to the PAYER when the receiver says "I haven't received it"
 *    (on the confirm page or in the app), once per dispute round.
 *  - "re-ask" notice: to the RECEIVER when the payer says "I've sent it - ask again"
 *    after a dispute (new token, same two buttons). Max 2 per payment, ever.
 *  - "retracted" notice: to the RECEIVER when the payer undoes "marked as paid".
 *
 * All are transactional (not gated by the trip's reminder switch) and are
 * outside the daily digest and its one-email-per-day cap.
 */
import { renderBrandedEmail, renderSecondaryButton, escapeHtml, BRAND_NAME } from './emailTemplate.ts'
import { formatMoneyExact } from './paymentMoney.ts'

export const PAID_NOTICE_KIND = 'payment_paid_notice'
export const CONFIRMED_NOTICE_KIND = 'payment_confirmed_notice'
export const DISPUTED_NOTICE_KIND = 'payment_disputed_notice'
/** Most notices of one kind a single person may be sent per rolling 24 hours (abuse guard, not a feature). */
export const NOTICE_DAILY_CAP_PER_RECIPIENT = 10
export const TOKEN_TTL_DAYS = 14
export const NOTE_MAX_CHARS = 300

export const REASK_NOTICE_KIND = 'payment_reask_notice'
export const RETRACTED_NOTICE_KIND = 'payment_retracted_notice'
/** Paid and re-ask notices share ONE sequence (the `:<n>` of notice:paid:...), capped per payment. */
export const PAID_TYPE_TOTAL_CAP = 4
/** Re-asks a single payment may ever have (the rest of the sequence is the initial and post-retract paid notices). */
export const REASK_CAP = 2
export const DISPUTED_PER_PAYMENT_CAP = 6
export const RETRACTED_PER_PAYMENT_CAP = 4

export const paidNoticeKey = (settlementId: string, receiverId: string, n = 1) => `notice:paid:${settlementId}:${receiverId}:${n}`
export const confirmedNoticeKey = (settlementId: string, payerId: string) => `notice:confirmed:${settlementId}:${payerId}:1`
export const disputedNoticeKey = (settlementId: string, payerId: string, round = 1) => `notice:disputed:${settlementId}:${payerId}:${round}`
export const retractedNoticeKey = (settlementId: string, receiverId: string, n = 1) => `notice:retracted:${settlementId}:${receiverId}:${n}`

// ---------------------------------------------------------------------------
// Who may ask for a notice (the function trusts nothing from the caller)
// ---------------------------------------------------------------------------

export interface ManagerFacts {
  isSiteAdmin: boolean
  isActiveOrganizer: boolean
  isTripCreator: boolean
}

/** Same rule as settlement_assert_can_manage (20261118100000): site admin, ACTIVE organiser, or trip creator. */
export function canManageTripFacts(f: ManagerFacts): boolean {
  return f.isSiteAdmin || f.isActiveOrganizer || f.isTripCreator
}

/** "paid": the payer, or someone who can manage the trip (recording it on the payer's behalf). */
export function mayRequestPaidNotice(input: { callerId: string; payerId: string; canManage: boolean }): boolean {
  return input.callerId === input.payerId || input.canManage
}

/** "confirmed": only the receiver themself. An organiser confirming on someone's behalf never triggers it. */
export function mayRequestConfirmedNotice(input: { callerId: string; receiverId: string }): boolean {
  return input.callerId === input.receiverId
}

/** "re_ask" and "retracted": the payer, or someone who can manage the trip. */
export const mayRequestReAsk = mayRequestPaidNotice
export const mayRequestRetractedNotice = mayRequestPaidNotice

/** "disputed" (in the app): only the receiver themself. */
export function mayRequestDisputedNotice(input: { callerId: string; receiverId: string }): boolean {
  return input.callerId === input.receiverId
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface RecipientFacts {
  email: string | null | undefined
  /** users.email_notifications_enabled: only an explicit false opts out. */
  emailNotificationsEnabled: boolean | null | undefined
  /** An email provider (Resend/Brevo) is configured. */
  channelAvailable: boolean
}

export type NoticeSkipReason =
  | 'not_marked_paid'
  | 'not_confirmed'
  | 'not_suggested'
  | 'not_retracted'
  | 'retract_stale'
  | 'not_disputed'
  | 'never_notified'
  | 'reask_limit'
  | 'already_sent'
  | 'capped'
  | 'same_person'
  | 'self_recorded'
  | 'opt_out'
  | 'no_email'
  | 'no_channel'

export interface NoticeDecision {
  send: boolean
  reason: NoticeSkipReason | null
}

const SEND: NoticeDecision = { send: true, reason: null }
const skip = (reason: NoticeSkipReason): NoticeDecision => ({ send: false, reason })

/** Same order of checks as decideEmailSuppression in auto-chase (opt-out first, then address, then provider). */
export function recipientDecision(r: RecipientFacts): NoticeDecision {
  if (r.emailNotificationsEnabled === false) return skip('opt_out')
  if (!r.email || !r.email.trim()) return skip('no_email')
  if (!r.channelAvailable) return skip('no_channel')
  return SEND
}

export function decidePaidNotice(input: {
  status: string
  payerId: string
  receiverId: string
  /** The caller asking for the notice. If it is the receiver, there is nobody to tell. */
  callerId: string
  receiver: RecipientFacts
}): NoticeDecision {
  if (input.status !== 'marked_paid') return skip('not_marked_paid')
  if (input.payerId === input.receiverId) return skip('same_person')
  if (input.callerId === input.receiverId) return skip('self_recorded')
  return recipientDecision(input.receiver)
}

/** "Not received": the payment must still be marked_paid (nothing to dispute once it is confirmed). */
export function decideDisputedNotice(input: { status: string; payerId: string; receiverId: string; payer: RecipientFacts }): NoticeDecision {
  if (input.status !== 'marked_paid') return skip('not_marked_paid')
  if (input.payerId === input.receiverId) return skip('same_person')
  return recipientDecision(input.payer)
}

// ---------------------------------------------------------------------------
// Sequence, rounds and caps (pure; the senders feed these counts from the database)
// ---------------------------------------------------------------------------

const ms = (iso: string) => new Date(iso).getTime()

/** The latest of some ISO timestamps, or null. */
export function latestIso(times: ReadonlyArray<string | null | undefined>): string | null {
  let best: string | null = null
  for (const t of times) if (t && (best === null || ms(t) > ms(best))) best = t
  return best
}

/** How many timestamps are strictly after `boundary` (null boundary = all of them). */
export function countAfter(times: ReadonlyArray<string>, boundary: string | null): number {
  return boundary === null ? times.length : times.filter((t) => ms(t) > ms(boundary)).length
}

export type SequenceDecision = { send: true; n: number } | { send: false; reason: 'already_sent' | 'capped' }

/**
 * The normal "paid" notice. `paidTypeTimes` = sent_at of every paid and re-ask notice this payment has had.
 * Sent at most once per "round" (a round starts at the payment's first marking and again after each retraction;
 * `lastRetractAt` = settlements.last_retracted_at, stamped by the database guard, never client-written), and at most PAID_TYPE_TOTAL_CAP in all so mark-paid / undo cannot ping-pong the receiver.
 */
export function decidePaidSequence(input: { paidTypeTimes: ReadonlyArray<string>; lastRetractAt: string | null }): SequenceDecision {
  if (countAfter(input.paidTypeTimes, input.lastRetractAt) >= 1) return { send: false, reason: 'already_sent' }
  const n = input.paidTypeTimes.length + 1
  return n > PAID_TYPE_TOTAL_CAP ? { send: false, reason: 'capped' } : { send: true, n }
}

/**
 * "Ask again". Allowed only on a marked_paid row that is currently disputed, at most REASK_CAP times per payment
 * (`reAsksUsed` = the larger of the two counters the sender keeps). `emailCapped` is true when the shared paid/re-ask
 * sequence is full: the flag is then still cleared but no email goes out.
 */
export function decideReAsk(input: { status: string; disputed: boolean; payerId: string; receiverId: string; reAsksUsed: number; paidTypeCount: number }):
  | { allowed: true; n: number | null }
  | { allowed: false; reason: NoticeSkipReason } {
  if (input.status !== 'marked_paid') return { allowed: false, reason: 'not_marked_paid' }
  if (input.payerId === input.receiverId) return { allowed: false, reason: 'same_person' }
  if (!input.disputed) return { allowed: false, reason: 'not_disputed' }
  if (input.reAsksUsed >= REASK_CAP) return { allowed: false, reason: 'reask_limit' }
  const n = input.paidTypeCount + 1
  return { allowed: true, n: n > PAID_TYPE_TOTAL_CAP ? null : n }
}

/** How long after the server stamped `settlements.last_retracted_at` the "hasn't paid yet" email may still be requested. */
export const RETRACT_EMAIL_WINDOW_MS = 30 * 60 * 1000

/**
 * "<Payer> hasn't paid the £X yet". The boundary is SERVER truth: `lastRetractedAt` is stamped by the database guard
 * whenever the payment goes marked_paid -> suggested, so this does not depend on any client call having happened.
 * The row must be back at `suggested` with a recent stamp; the receiver must have been told it was paid (otherwise
 * they would hear about a payment they never saw); one email per retraction (none sent since that stamp); at most
 * RETRACTED_PER_PAYMENT_CAP per payment.
 */
export function decideRetractedSequence(input: {
  status: string
  paidTypeTimes: ReadonlyArray<string>
  retractedTimes: ReadonlyArray<string>
  lastRetractedAt: string | null
  now?: Date
}): SequenceDecision | { send: false; reason: 'not_suggested' | 'never_notified' | 'not_retracted' | 'retract_stale' } {
  if (input.status !== 'suggested') return { send: false, reason: 'not_suggested' }
  if (!input.lastRetractedAt) return { send: false, reason: 'not_retracted' }
  if ((input.now ?? new Date()).getTime() - ms(input.lastRetractedAt) > RETRACT_EMAIL_WINDOW_MS) return { send: false, reason: 'retract_stale' }
  if (latestIso(input.paidTypeTimes) === null) return { send: false, reason: 'never_notified' }
  if (countAfter(input.retractedTimes, input.lastRetractedAt) >= 1) return { send: false, reason: 'already_sent' }
  const n = input.retractedTimes.length + 1
  return n > RETRACTED_PER_PAYMENT_CAP ? { send: false, reason: 'capped' } : { send: true, n }
}

/** One "says they haven't received it" email per dispute round (a round starts at each paid / re-ask notice); 6 per payment. */
export function decideDisputedRound(input: { disputedTimes: ReadonlyArray<string>; paidTypeTimes: ReadonlyArray<string> }): SequenceDecision {
  if (countAfter(input.disputedTimes, latestIso(input.paidTypeTimes)) >= 1) return { send: false, reason: 'already_sent' }
  const n = input.disputedTimes.length + 1
  return n > DISPUTED_PER_PAYMENT_CAP ? { send: false, reason: 'capped' } : { send: true, n }
}

/** Over the per-recipient daily cap for one kind of notice. */
export function overDailyCap(sentInLast24h: number | null | undefined): boolean {
  return (sentInLast24h ?? NOTICE_DAILY_CAP_PER_RECIPIENT) >= NOTICE_DAILY_CAP_PER_RECIPIENT
}

export function decideConfirmedNotice(input: { status: string; payerId: string; receiverId: string; payer: RecipientFacts }): NoticeDecision {
  if (input.status !== 'confirmed') return skip('not_confirmed')
  if (input.payerId === input.receiverId) return skip('same_person')
  return recipientDecision(input.payer)
}

/**
 * "You're square" is only said when it is provably true from payment rows: the
 * trip's balances are frozen (so the payment rows ARE the whole obligation),
 * the payer has no other unfinished payment (to make or to receive), and no
 * carried-over balance involves them. Anything unknown counts as not square.
 */
export function isPayerSquare(input: { tripFrozen: boolean; otherUnfinishedPaymentsByPayer: number | null; carryoversInvolvingPayer: number | null }): boolean {
  return input.tripFrozen && input.otherUnfinishedPaymentsByPayer === 0 && input.carryoversInvolvingPayer === 0
}

// ---------------------------------------------------------------------------
// Names and text hygiene
// ---------------------------------------------------------------------------

export function displayFirstName(u: { first_name?: string | null; full_name?: string | null } | null | undefined, fallback = 'Someone'): string {
  const first = u?.first_name?.trim()
  if (first) return first
  const full = u?.full_name?.trim().split(/\s+/)[0]
  return full || fallback
}

/** Header-safe single line (no CR/LF), trimmed. */
export function oneLine(s: string): string {
  return s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function trimNote(note: string | null | undefined): string | null {
  const n = (note ?? '').replace(/\s+/g, ' ').trim()
  if (!n) return null
  return n.length > NOTE_MAX_CHARS ? `${n.slice(0, NOTE_MAX_CHARS - 1)}…` : n
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** `a` is only a hint for which answer the page pre-selects; the server never trusts it. */
export function confirmPageUrl(appBaseUrl: string, token: string, answer?: 'yes' | 'no'): string {
  return `${appBaseUrl}/confirm-payment?t=${encodeURIComponent(token)}${answer ? `&a=${answer}` : ''}`
}

/** Same shape as DEEP_LINKS.payment: `/<tripId>?open=payment:<id>`. */
export function paymentAppUrl(appBaseUrl: string, tripId: string, settlementId: string): string {
  return `${appBaseUrl}/${tripId}?open=payment:${settlementId}`
}

export function tripUrl(appBaseUrl: string, tripId: string): string {
  return `${appBaseUrl}/${tripId}`
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

export interface RenderedNotice {
  subject: string
  html: string
  text: string
}

const INK = '#1c1917'
const MUTED = '#78716c'
const BRAND = '#0f766e'

const OFF_LINE = 'To turn emails off, open your profile and go to Email notifications.'

export interface PaidNoticeInput {
  receiverFirstName: string
  payerName: string
  /** Set when someone other than the payer recorded the payment ("Tim recorded that Salim paid you"). */
  recordedByName: string | null
  amount: number
  currency: string
  tripName: string
  /** settlements.notes; shown only if present. */
  note: string | null
  /** `/confirm-payment?t=<token>&a=yes` (primary button). */
  confirmYesUrl: string
  /** `/confirm-payment?t=<token>&a=no` (secondary button). */
  confirmNoUrl: string
  appUrl: string
}

export function paidNoticeSubject(i: Pick<PaidNoticeInput, 'payerName' | 'amount' | 'currency' | 'tripName'>): string {
  return oneLine(`${i.payerName} paid you ${formatMoneyExact(i.amount, i.currency)} — ${i.tripName}`)
}

const YES_LABEL = 'Yes, I received it'
const NO_LABEL = "I haven't received it"
const ASK_LINE = 'Once it has arrived, let us know. Nothing changes until you choose.'

/** Shared body of the two receipt-request emails (first ask and re-ask): lead, optional note, two buttons, app link. */
function renderReceiptRequest(i: PaidNoticeInput, lead: string, footerLine: string, subject: string, noteLabel: string): RenderedNotice {
  const note = trimNote(i.note)
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:${INK};">Hi ${escapeHtml(i.receiverFirstName)},</p>
    <p style="margin:0 0 8px;font-size:16px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(lead)}</p>
    ${note ? `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(noteLabel)}: &ldquo;${escapeHtml(note)}&rdquo;</p>` : ''}
    <p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(ASK_LINE)}</p>`
  const after = `${renderSecondaryButton(NO_LABEL, i.confirmNoUrl)}<p style="margin:12px 0 0;text-align:center;font-size:13px;line-height:1.5;color:${MUTED};">Prefer to sign in? <a href="${escapeHtml(i.appUrl)}" style="color:${BRAND};">Open this payment in the app</a>.</p>`
  const html = renderBrandedEmail({ bodyHtml: body, ctaLabel: YES_LABEL, ctaUrl: i.confirmYesUrl, footerLine, afterCtaHtml: after })
  const text = [
    `Hi ${i.receiverFirstName},`,
    '',
    lead,
    ...(note ? [`${noteLabel}: "${note}"`] : []),
    '',
    ASK_LINE,
    '',
    `${YES_LABEL}: ${i.confirmYesUrl}`,
    `${NO_LABEL}: ${i.confirmNoUrl}`,
    `Or open this payment in the app: ${i.appUrl}`,
    '',
    footerLine,
  ].join('\n')
  return { subject, html, text }
}

export function renderPaidNotice(i: PaidNoticeInput): RenderedNotice {
  const money = formatMoneyExact(i.amount, i.currency)
  const lead = i.recordedByName
    ? `${i.recordedByName} recorded that ${i.payerName} paid you ${money} for ${i.tripName}.`
    : `${i.payerName} says they paid you ${money} for ${i.tripName}.`
  const noteLabel = i.recordedByName ? 'Note' : `${i.payerName}'s note`
  const footerLine = `You're getting this because ${i.recordedByName ?? i.payerName} recorded a payment to you on ${i.tripName}. ${OFF_LINE}`
  return renderReceiptRequest(i, lead, footerLine, paidNoticeSubject(i), noteLabel)
}

export function reAskNoticeSubject(i: Pick<PaidNoticeInput, 'payerName' | 'amount' | 'currency'>): string {
  return oneLine(`${i.payerName} says they've sent ${formatMoneyExact(i.amount, i.currency)} — can you check again?`)
}

/** "<Payer> says they've sent £X — can you check again?" Same two buttons, a NEW token. */
export function renderReAskNotice(i: PaidNoticeInput): RenderedNotice {
  const money = formatMoneyExact(i.amount, i.currency)
  const lead = `${i.payerName} says they've sent ${money} — can you check again? (${i.tripName})`
  const footerLine = `You're getting this because ${i.payerName} paid you on ${i.tripName}. ${OFF_LINE}`
  return renderReceiptRequest({ ...i, recordedByName: null }, lead, footerLine, reAskNoticeSubject(i), `${i.payerName}'s note`)
}

export interface RetractedNoticeInput {
  receiverFirstName: string
  payerName: string
  amount: number
  currency: string
  tripName: string
  tripUrl: string
}

export function retractedNoticeSubject(i: Pick<RetractedNoticeInput, 'payerName' | 'amount' | 'currency' | 'tripName'>): string {
  return oneLine(`${i.payerName} hasn't paid the ${formatMoneyExact(i.amount, i.currency)} yet — ${i.tripName}`)
}

export function renderRetractedNotice(i: RetractedNoticeInput): RenderedNotice {
  const money = formatMoneyExact(i.amount, i.currency)
  const lead = `${i.payerName} hasn't paid the ${money} yet — they'll mark it paid when they have.`
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:${INK};">Hi ${escapeHtml(i.receiverFirstName)},</p>
    <p style="margin:0;font-size:16px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(lead)}</p>`
  const footerLine = `You're getting this because ${i.payerName} had told you they paid you on ${i.tripName}. ${OFF_LINE}`
  const html = renderBrandedEmail({ bodyHtml: body, ctaLabel: `Open ${i.tripName}`, ctaUrl: i.tripUrl, footerLine })
  const text = [`Hi ${i.receiverFirstName},`, '', lead, '', `Open ${i.tripName}: ${i.tripUrl}`, '', footerLine].join('\n')
  return { subject: retractedNoticeSubject(i), html, text }
}

export interface ConfirmedNoticeInput {
  payerFirstName: string
  receiverName: string
  amount: number
  currency: string
  tripName: string
  square: boolean
  tripUrl: string
}

export function confirmedNoticeSubject(i: Pick<ConfirmedNoticeInput, 'receiverName' | 'amount' | 'currency' | 'tripName'>): string {
  return oneLine(`${i.receiverName} confirmed your ${formatMoneyExact(i.amount, i.currency)} — ${i.tripName}`)
}

export function renderConfirmedNotice(i: ConfirmedNoticeInput): RenderedNotice {
  const money = formatMoneyExact(i.amount, i.currency)
  const lead = i.square
    ? `${i.receiverName} confirmed your ${money} — you're square for ${i.tripName}.`
    : `${i.receiverName} confirmed your ${money} for ${i.tripName}.`
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:${INK};">Hi ${escapeHtml(i.payerFirstName)},</p>
    <p style="margin:0;font-size:16px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(lead)}</p>`
  const footerLine = `You're getting this because you paid ${i.receiverName} on ${i.tripName}. ${OFF_LINE}`
  const html = renderBrandedEmail({ bodyHtml: body, ctaLabel: `Open ${i.tripName}`, ctaUrl: i.tripUrl, footerLine })
  const text = [`Hi ${i.payerFirstName},`, '', lead, '', `Open ${i.tripName}: ${i.tripUrl}`, '', footerLine].join('\n')
  return { subject: confirmedNoticeSubject(i), html, text }
}

export interface DisputedNoticeInput {
  payerFirstName: string
  receiverName: string
  amount: number
  currency: string
  tripName: string
  tripUrl: string
}

export function disputedNoticeSubject(i: Pick<DisputedNoticeInput, 'receiverName' | 'amount' | 'currency'>): string {
  return oneLine(`${i.receiverName} says they haven't received your ${formatMoneyExact(i.amount, i.currency)} yet`)
}

export function renderDisputedNotice(i: DisputedNoticeInput): RenderedNotice {
  const money = formatMoneyExact(i.amount, i.currency)
  const lead = `${i.receiverName} says they haven't received your ${money} yet for ${i.tripName}.`
  const hint = 'It may still be on its way. If you have paid, it is worth checking the details with them.'
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:${INK};">Hi ${escapeHtml(i.payerFirstName)},</p>
    <p style="margin:0 0 8px;font-size:16px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(lead)}</p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(hint)}</p>`
  const footerLine = `You're getting this because you paid ${i.receiverName} on ${i.tripName}. ${OFF_LINE}`
  const html = renderBrandedEmail({ bodyHtml: body, ctaLabel: `Open ${i.tripName}`, ctaUrl: i.tripUrl, footerLine })
  const text = [`Hi ${i.payerFirstName},`, '', lead, hint, '', `Open ${i.tripName}: ${i.tripUrl}`, '', footerLine].join('\n')
  return { subject: disputedNoticeSubject(i), html, text }
}

export { BRAND_NAME }

// ---------------------------------------------------------------------------
// Confirm page: state of a token
// ---------------------------------------------------------------------------

export type ConfirmState = 'valid' | 'confirmed' | 'disputed' | 'asked_again' | 'retracted' | 'expired' | 'changed' | 'invalid'

export interface TokenFacts {
  receiver_id: string
  amount: number
  currency: string
  expires_at: string
  used_at: string | null
  used_action: string | null
}

export interface SettlementFacts {
  status: string
  to_user_id: string
  amount: number
  /** Already coalesced with the trip's base currency (as the token captured it). */
  currency: string
  /** settlements.receipt_disputed_at. `undefined` = the column does not exist yet (old behaviour). */
  receipt_disputed_at?: string | null
  /** settlements.last_retracted_at (guard-stamped). `undefined`/null = never, or the column does not exist yet. */
  last_retracted_at?: string | null
}

const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.0000005

/**
 * Mirrors _payment_token_check (SQL), for the read-only 'peek'. An old link always shows the CURRENT truth, derived
 * only from server facts: the payment's status and flag, when it was last taken back (`last_retracted_at`) and whether
 * a NEWER link exists for it (`newerToken`). Where the server cannot know who changed the payment (the payer taking it
 * back, or an organizer moving it back) the answer is neutral wording.
 */
export function mapTokenState(input: { token: TokenFacts | null; settlement: SettlementFacts | null; now: Date; newerToken?: boolean }): ConfirmState {
  const { token, settlement, now } = input
  if (!token) return 'invalid'
  if (token.used_at || token.used_action) {
    // The link shows the CURRENT truth: once the payment is confirmed (in the app, by an organizer,
    // or by this link) that is what it says, whatever the token was used for.
    if (settlement?.status === 'confirmed') return 'confirmed'
    if (token.used_action === 'confirmed') return 'confirmed'
    if (settlement?.status === 'suggested') return 'retracted' // no longer marked as paid (payer or organizer: unknown)
    if (settlement?.status === 'marked_paid' && settlement.receipt_disputed_at !== undefined) {
      // The receiver said "not received" and the payer has not answered yet.
      if (settlement.receipt_disputed_at) return 'disputed'
      const newer = input.newerToken ?? false
      // Taken back and marked paid again AFTER this link was used: that is a new payment round, not an "ask again".
      const retractedSince = !!settlement.last_retracted_at && !!token.used_at && new Date(settlement.last_retracted_at).getTime() > new Date(token.used_at).getTime()
      // This link said "No", the payer then asked again. This OLD link has no power; the new email has the new link.
      if (token.used_action === 'disputed' && newer && !retractedSince) return 'asked_again'
      return newer ? 'expired' : 'changed' // superseded by a newer email, or changed by someone and we cannot tell how
    }
    if (token.used_action === 'disputed') return 'disputed'
    return 'expired' // superseded by a newer email
  }
  if (new Date(token.expires_at).getTime() <= now.getTime()) return 'expired'
  if (!settlement) return 'changed'
  if (settlement.status === 'confirmed') return 'confirmed'
  if (
    settlement.status !== 'marked_paid' ||
    settlement.to_user_id !== token.receiver_id ||
    !sameAmount(settlement.amount, token.amount) ||
    settlement.currency !== token.currency
  ) {
    return 'changed'
  }
  return 'valid'
}

/** Map a confirm_payment_by_token / dispute_payment_by_token result to the page state. */
export function mapRpcResult(result: unknown, usedAction: unknown): ConfirmState {
  switch (result) {
    case 'confirmed':
    case 'already_confirmed':
      return 'confirmed'
    case 'disputed':
      return 'disputed'
    case 'used':
      return usedAction === 'confirmed' ? 'confirmed' : usedAction === 'disputed' ? 'disputed' : 'expired'
    case 'expired':
      return 'expired'
    case 'changed':
      return 'changed'
    default:
      return 'invalid'
  }
}

// ---------------------------------------------------------------------------
// CORS for the public confirm function
// ---------------------------------------------------------------------------

/** Allowed browser origins: the app's own origin(s) only. `extra` is a comma-separated list. */
export function allowedOrigins(appBaseUrl: string, extra: string | undefined): string[] {
  const out = new Set<string>()
  const add = (u: string) => {
    try {
      const o = new URL(u.trim())
      if (o.protocol === 'https:' || o.hostname === 'localhost') out.add(o.origin)
    } catch {
      /* ignore junk */
    }
  }
  add(appBaseUrl)
  for (const e of (extra ?? '').split(',')) if (e.trim()) add(e)
  return [...out]
}

export function isAllowedOrigin(origin: string | null, allowed: string[]): origin is string {
  return !!origin && allowed.includes(origin)
}

/** Best-effort client IP behind the Supabase gateway. */
export function clientIp(headers: Headers): string {
  const fwd = headers.get('cf-connecting-ip') ?? headers.get('x-real-ip') ?? headers.get('x-forwarded-for') ?? ''
  return fwd.split(',')[0].trim() || 'unknown'
}
