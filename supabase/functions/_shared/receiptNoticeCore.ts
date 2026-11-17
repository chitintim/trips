/**
 * Pure logic for the receipt notices (no I/O, no Deno APIs beyond Web Crypto): who may ask, who may be emailed, how often,
 * the dedupe keys, the items a person was put down for, the three emails and the mapping of database answers to HTTP answers.
 *
 * Mirrors the shape of paymentNoticeCore.ts and reuses its gates, name and text helpers, the shared branded email shell and the
 * shared exact-mode money formatter. The I/O half is receiptNoticeSend.ts.
 *
 * Vocabulary (docs/PRODUCT_MODEL.md): "Send to the table", "That's everything", "I wasn't there", "unclaimed items".
 */
import { escapeHtml, renderBrandedEmail, renderSecondaryButton } from './emailTemplate.ts'
import { formatMoneyExact } from './paymentMoney.ts'
import { fromMinorUnits, toMinorUnits } from './money/minorUnits.ts'
import { sha256Hex } from './paymentToken.ts'
import { oneLine, recipientDecision, type RecipientFacts, type RenderedNotice } from './paymentNoticeCore.ts'

export type { RenderedNotice }

// ---------------------------------------------------------------------------
// Kinds, keys and caps
// ---------------------------------------------------------------------------

export const RECEIPT_TABLE_KIND = 'receipt_table'
export const RECEIPT_REMINDER_KIND = 'receipt_reminder'
export const RECEIPT_RESULT_KIND = 'receipt_result'
/** Marker rows that remember which assigned items a table email showed (never sent anywhere, never counted in the cap). */
export const RECEIPT_TABLE_FP_KIND = 'receipt_table_fp'
export const RECEIPT_KINDS = [RECEIPT_TABLE_KIND, RECEIPT_REMINDER_KIND, RECEIPT_RESULT_KIND] as const

/** At most this many receipt notices (all kinds together) per person per rolling 24 hours. */
export const RECEIPT_DAILY_CAP = 6
/** At most this many "put you down" emails per person per receipt (the first plus two changes). */
export const TABLE_PER_RECEIPT_CAP = 3
/** At most this many reminders per person per receipt (one per deadline day: the first deadline and one after a reopen / move). */
export const REMINDER_PER_RECEIPT_CAP = 2
/** At most this many result notices per person per receipt (the first close and one more, only if the amount changed after a reopen). */
export const RESULT_PER_RECEIPT_CAP = 2
/** The reminder goes out when the deadline is at most this far away. */
export const REMINDER_WINDOW_MS = 25 * 3600 * 1000

export const tableNoticeKey = (expenseId: string, userId: string, n = 1) =>
  n <= 1 ? `notice:receipt:${expenseId}:${userId}:table` : `notice:receipt:${expenseId}:${userId}:table:${n}`
export const tableFingerprintKey = (expenseId: string, userId: string, n: number, fp: string) => `notice:receipt:${expenseId}:${userId}:tablefp:${n}:${fp}`
/** UTC calendar day of a deadline ("2026-11-20"); the reminder is once per deadline DAY, so a deadline moved to another day (extend, reopen) gets its own reminder. */
export function deadlineDay(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'none'
}
export const reminderNoticeKey = (expenseId: string, userId: string, deadlineIso: string | null | undefined) =>
  `notice:receipt:${expenseId}:${userId}:reminder:${deadlineDay(deadlineIso)}`
/** The key carries the leftover amount in minor units, so "told about THIS amount" is readable from the key itself (a reopened, re-closed receipt can tell the person once more if the amount changed). */
export const resultNoticeKey = (expenseId: string, userId: string, leftoverMinor: number) => `notice:receipt:${expenseId}:${userId}:result:${leftoverMinor}`
/** LIKE pattern matching every key written for one person and one receipt. */
export const receiptKeyPrefix = (expenseId: string, userId: string) => `notice:receipt:${expenseId}:${userId}:`

// ---------------------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------------------

/** The payer or someone who can manage the trip may send a receipt to the table (the database re-checks as the caller). */
export function mayRequestSendToTable(input: { callerId: string; payerId: string | null | undefined; canManage: boolean }): boolean {
  return !!input.payerId && (input.callerId === input.payerId || input.canManage)
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export type ReceiptSkipReason =
  | 'opt_out'
  | 'no_email'
  | 'no_channel'
  | 'same_person'
  | 'notices_off'
  | 'frozen'
  | 'closed'
  | 'not_open'
  | 'not_closed'
  | 'not_due'
  | 'not_on_receipt'
  | 'responded'
  | 'engaged'
  | 'zero_amount'
  | 'already_sent'
  | 'capped'
  | 'not_found'
  | 'not_available'

export interface ReceiptDecision {
  send: boolean
  reason: ReceiptSkipReason | null
}
const SEND: ReceiptDecision = { send: true, reason: null }
const skip = (reason: ReceiptSkipReason): ReceiptDecision => ({ send: false, reason })

export interface ReceiptFacts {
  /** trips.receipt_notices_enabled (null/undefined counts as on, the column default). */
  noticesEnabled: boolean | null | undefined
  /** trips.settlement_snapshot is set. */
  frozen: boolean
  claimsSentAt: string | null
  claimsClosedAt: string | null
  claimDeadline: string | null
}

export type ReceiptNoticeType = 'table' | 'reminder' | 'result'

/**
 * Everything that does not need the notifications table. Order: who (never the person who triggered it), the trip switch, the
 * state of the receipt for this kind of email, then the recipient's own email settings (same order as the payment notices).
 * The result email is about something that already happened, so it ignores freeze and the deadline; it needs the receipt closed.
 */
export function decideReceiptNotice(input: {
  type: ReceiptNoticeType
  receipt: ReceiptFacts
  recipient: RecipientFacts
  recipientId: string
  /** Who triggered this send (the caller of send_to_table); never emailed. Null for the daily job. */
  actorId: string | null
  now: Date
}): ReceiptDecision {
  const { type, receipt: r, now } = input
  if (input.actorId && input.actorId === input.recipientId) return skip('same_person')
  if (r.noticesEnabled === false) return skip('notices_off')
  if (type === 'result') {
    if (!r.claimsClosedAt) return skip('not_closed')
  } else {
    if (!r.claimsSentAt) return skip('not_open')
    if (r.claimsClosedAt) return skip('closed')
    if (r.frozen) return skip('frozen')
    const deadline = r.claimDeadline ? Date.parse(r.claimDeadline) : NaN
    if (Number.isFinite(deadline) && deadline <= now.getTime()) return skip('closed')
    if (type === 'reminder') {
      // A reminder needs a real deadline, at most ~25 hours ahead.
      if (!Number.isFinite(deadline) || deadline - now.getTime() > REMINDER_WINDOW_MS) return skip('not_due')
    }
  }
  const rd = recipientDecision(input.recipient)
  return rd.send ? SEND : skip(rd.reason as ReceiptSkipReason)
}

/** Over the shared per-person cap. An unknown count (the query failed) counts as over. */
export function overReceiptCap(sentInLast24h: number | null | undefined): boolean {
  return (sentInLast24h ?? RECEIPT_DAILY_CAP) >= RECEIPT_DAILY_CAP
}

/** Reminder: once ever, and only for people who have neither answered nor changed their own items since being put down. */
export function decideReminderEngagement(input: { hasResponse: boolean; ownChangeAt: string | null; baselineAt: string | null }): ReceiptDecision {
  if (input.hasResponse) return skip('responded')
  if (input.ownChangeAt && (!input.baselineAt || Date.parse(input.ownChangeAt) > Date.parse(input.baselineAt))) return skip('engaged')
  return SEND
}

export type NoticeSequence = { send: true } | { send: false; reason: 'already_sent' | 'capped' }

/**
 * Reminder: once per deadline day, at most 2 per receipt and person. `priorKeys` = dedupe keys of this person's reminder rows for this receipt.
 */
export function decideReminderSequence(input: { priorKeys: string[]; key: string }): NoticeSequence {
  if (input.priorKeys.includes(input.key)) return { send: false, reason: 'already_sent' }
  if (input.priorKeys.length >= REMINDER_PER_RECEIPT_CAP) return { send: false, reason: 'capped' }
  return { send: true }
}

/** The leftover amount (minor units) a result key was written for; null for a key without one. */
export function resultKeyAmount(key: string): number | null {
  const m = /:result:(\d+)$/.exec(key)
  return m ? Number(m[1]) : null
}

/**
 * Result notice: the first close tells the person. After a reopen and a second close, tell them once more ONLY if their leftover amount differs
 * from the one in their most recent result notice; never more than 2 per receipt and person. `priorKeys` = this person's result keys for this
 * receipt, oldest first.
 */
export function decideResultSequence(input: { priorKeys: string[]; leftoverMinor: number }): NoticeSequence {
  if (input.priorKeys.length === 0) return { send: true }
  const last = resultKeyAmount(input.priorKeys[input.priorKeys.length - 1])
  if (last === null || last === input.leftoverMinor) return { send: false, reason: 'already_sent' }
  if (input.priorKeys.length >= RESULT_PER_RECEIPT_CAP) return { send: false, reason: 'capped' }
  return { send: true }
}

// ---------------------------------------------------------------------------
// The table email: first send and re-sends
// ---------------------------------------------------------------------------

export type TableSequence = { send: true; n: number } | { send: false; reason: 'already_sent' | 'capped' }

/**
 * `priorCount` = table emails already recorded for this person and receipt (rows with key ...:table, ...:table:2, ...).
 * `lastFingerprint` = what the most recent one showed (null = unknown), `fingerprint` = the person's assigned items now.
 * First email: always. After that: only when the assigned items changed (or `force`), and never beyond the cap. Unknown last state sends nothing.
 */
export function decideTableSequence(input: { priorCount: number; lastFingerprint: string | null; fingerprint: string; force?: boolean }): TableSequence {
  if (input.priorCount <= 0) return { send: true, n: 1 }
  if (input.priorCount >= TABLE_PER_RECEIPT_CAP) return { send: false, reason: 'capped' }
  // force = the payer asked for this person to be emailed again (resend_user_ids): skips only the "items unchanged" rule, never the per-receipt cap.
  if (input.force) return { send: true, n: input.priorCount + 1 }
  if (input.lastFingerprint === null || input.lastFingerprint === input.fingerprint) return { send: false, reason: 'already_sent' }
  return { send: true, n: input.priorCount + 1 }
}

export interface LineRow {
  id: string
  line_number: number
  name_original: string | null
  name_english: string | null
  quantity: number | null
  total_amount: number | null
  shared_by_all: boolean | null
}
export interface ClaimRow {
  line_item_id: string
  user_id: string
  quantity_claimed: number | null
  leftover_quantity: number | null
  amount_owed: number | null
  leftover_amount: number | null
  created_by: string | null
  updated_at?: string | null
}

export interface PersonItem {
  lineItemId: string
  name: string
  amountMinor: number
  /** People sharing this item, including this person (1 = theirs alone). */
  sharedWith: number
  /** A table item everyone shares. */
  everyone: boolean
  /** Put down by someone other than the person themselves. */
  assigned: boolean
}

const NAME_MAX = 80
const toMinor = (n: number | null | undefined, currency: string): number => {
  const v = Number(n ?? 0)
  return Number.isFinite(v) ? toMinorUnits(v, currency) : 0
}

export function lineDisplayName(line: Pick<LineRow, 'name_original' | 'name_english' | 'line_number'>): string {
  const orig = oneLine(line.name_original ?? '')
  const eng = oneLine(line.name_english ?? '')
  let name = orig && eng && eng.toLowerCase() !== orig.toLowerCase() ? `${orig} (${eng})` : orig || eng || `Item ${line.line_number}`
  if (name.length > NAME_MAX) name = `${name.slice(0, NAME_MAX - 1)}…`
  return name
}

/** The items a person is on: their own part of each line, who else shares it, who put it down. Leftover parts are not "items". */
export function personItems(input: { lines: LineRow[]; claims: ClaimRow[]; userId: string; currency: string }): { items: PersonItem[]; totalMinor: number } {
  const ownQty = (c: ClaimRow) => Number(c.quantity_claimed ?? 0) - Number(c.leftover_quantity ?? 0)
  const ownAmt = (c: ClaimRow) => Number(c.amount_owed ?? 0) - Number(c.leftover_amount ?? 0)
  const byLine = new Map<string, ClaimRow[]>()
  for (const c of input.claims) {
    if (ownQty(c) <= 0) continue
    byLine.set(c.line_item_id, [...(byLine.get(c.line_item_id) ?? []), c])
  }
  const items: PersonItem[] = []
  const sorted = [...input.lines].sort((a, b) => a.line_number - b.line_number || a.id.localeCompare(b.id))
  for (const line of sorted) {
    const claimants = byLine.get(line.id) ?? []
    const mine = claimants.find((c) => c.user_id === input.userId)
    if (!mine) continue
    const amountMinor = toMinor(ownAmt(mine), input.currency)
    if (amountMinor <= 0) continue
    items.push({
      lineItemId: line.id,
      name: lineDisplayName(line),
      amountMinor,
      sharedWith: Math.max(1, new Set(claimants.map((c) => c.user_id)).size),
      everyone: !!line.shared_by_all,
      assigned: !!mine.created_by && mine.created_by !== input.userId,
    })
  }
  return { items, totalMinor: items.reduce((s, i) => s + i.amountMinor, 0) }
}

/** Short stable summary of the items somebody ELSE put this person down for (their own edits do not count as the payer's changes). */
export async function assignedFingerprint(items: PersonItem[]): Promise<string> {
  const assigned = items.filter((i) => i.assigned).map((i) => `${i.lineItemId}:${i.amountMinor}`).sort()
  if (assigned.length === 0) return 'none'
  return (await sha256Hex(assigned.join('|'))).slice(0, 12)
}

/** The most recent own edit: a claim on an ordinary line the person recorded themselves. Returns its updated_at or null. */
export function latestOwnChange(claims: ClaimRow[], userId: string, lines: ReadonlyArray<Pick<LineRow, 'id' | 'shared_by_all'>> = []): string | null {
  // Shares on table items (shared_by_all) are re-split by the database whenever somebody says "I wasn't there": a derived write, never the person's own change.
  const tableLines = new Set(lines.filter((l) => l.shared_by_all).map((l) => l.id))
  let best: string | null = null
  for (const c of claims) {
    if (c.user_id !== userId || !c.updated_at || tableLines.has(c.line_item_id)) continue
    if (c.created_by && c.created_by !== userId) continue // put down by somebody else: not their own change
    if (!best || Date.parse(c.updated_at) > Date.parse(best)) best = c.updated_at
  }
  return best
}

// ---------------------------------------------------------------------------
// Wording and links
// ---------------------------------------------------------------------------

export const RULE_SENTENCE =
  "Anything nobody claims by then is split between people who haven't said 'That's everything' (never more than an even share each), and the rest is shared by everyone."
export const DONE_LABEL = "That's everything"
export const CHANGE_LABEL = 'Change my items'
export const NOT_THERE_LABEL = "I wasn't there"

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Fri 20 Nov, 18:00 UTC". Trips have no timezone, so UTC is said out loud. The year is added only when it is not the current one. */
export function formatDeadline(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const year = d.getUTCFullYear() === now.getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}, ${hh}:${mm} UTC`
}

/** The page the personal link opens (the app routes it). */
export const RECEIPT_PAGE_PATH = '/receipt'

/**
 * `https://trips.fontem.ai/receipt#t=<token>[&a=done]`. The token sits in the URL FRAGMENT, which browsers never send to a server, so it
 * cannot reach the host's access logs, the gateway or a Referer header; the page reads it, then clears the address bar.
 * `a` only pre-selects an answer on the page; the server never trusts it (the page must still POST).
 */
export function receiptPageUrl(appBaseUrl: string, token: string, answer?: 'done' | 'not_there'): string {
  return `${appBaseUrl}${RECEIPT_PAGE_PATH}#t=${encodeURIComponent(token)}${answer ? `&a=${answer}` : ''}`
}

/** Same shape as the other deep links: `/<tripId>?open=claim:<expenseId>` (the signed-in way in). */
export function receiptAppUrl(appBaseUrl: string, tripId: string, expenseId: string): string {
  return `${appBaseUrl}/${tripId}?open=claim:${expenseId}`
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

const INK = '#1c1917'
const MUTED = '#78716c'
const BRAND = '#0f766e'
const BORDER = '#e7e5e4'
const OFF_LINE = 'To turn emails off, open your profile and go to Email notifications.'

const money = (minor: number, currency: string) => formatMoneyExact(fromMinorUnits(minor, currency), currency)

export type ClaimEmailVariant = 'put_down' | 'tell_us' | 'reminder'

export interface ClaimEmailInput {
  variant: ClaimEmailVariant
  recipientFirstName: string
  payerName: string
  receiptTitle: string
  tripName: string
  currency: string
  items: PersonItem[]
  totalMinor: number
  deadlineIso: string | null
  now?: Date
  /** `/receipt#t=<token>&a=done` */
  doneUrl: string
  /** `/receipt#t=<token>` */
  changeUrl: string
  /** `/receipt#t=<token>&a=not_there` */
  notThereUrl: string
  appUrl: string
}

export function claimEmailSubject(i: Pick<ClaimEmailInput, 'variant' | 'payerName' | 'receiptTitle' | 'tripName' | 'currency' | 'totalMinor' | 'deadlineIso' | 'now'>): string {
  if (i.variant === 'reminder') {
    const when = formatDeadline(i.deadlineIso, i.now)
    return oneLine(`Reminder: ${i.receiptTitle} closes ${when ?? 'soon'} · ${i.tripName}`)
  }
  if (i.variant === 'put_down') return oneLine(`${i.payerName} put you down for ${money(i.totalMinor, i.currency)} — ${i.receiptTitle} · ${i.tripName}`)
  return oneLine(`${i.payerName} added ${i.receiptTitle} — tell us what you had`)
}

function itemSuffix(it: PersonItem): string {
  if (it.everyone) return ' (shared by everyone)'
  return it.sharedWith > 1 ? ` (÷${it.sharedWith})` : ''
}

export function renderClaimEmail(i: ClaimEmailInput): RenderedNotice {
  const subject = claimEmailSubject(i)
  const deadline = formatDeadline(i.deadlineIso, i.now)
  const replyBy = deadline ? `Reply by ${deadline}.` : null
  const total = money(i.totalMinor, i.currency)
  const lead =
    i.variant === 'put_down'
      ? `${i.payerName} put you down for ${total} on ${i.receiptTitle} (${i.tripName}).`
      : i.variant === 'reminder'
        ? `${i.receiptTitle} (${i.tripName}) closes soon. ${i.items.length > 0 ? `You're down for ${total} so far.` : "We don't have anything down for you yet."}`
        : `${i.payerName} added ${i.receiptTitle} (${i.tripName}). Tell us what you had.`
  const ask =
    i.items.length > 0
      ? "If this is right, tap 'That's everything'. If not, change your items."
      : "Tap what you had, or say you weren't there."

  const rows = i.items
    .map(
      (it) =>
        `<tr><td style="padding:6px 12px 6px 0;border-bottom:1px solid ${BORDER};font-size:14px;color:${INK};">${escapeHtml(it.name)}${escapeHtml(itemSuffix(it))}</td><td align="right" style="padding:6px 0;border-bottom:1px solid ${BORDER};font-size:14px;color:${INK};white-space:nowrap;">${escapeHtml(money(it.amountMinor, i.currency))}</td></tr>`
    )
    .join('')
  const table =
    i.items.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 4px;">${rows}<tr><td style="padding:8px 12px 0 0;font-size:14px;font-weight:700;color:${INK};">Your total</td><td align="right" style="padding:8px 0 0;font-size:14px;font-weight:700;color:${INK};white-space:nowrap;">${escapeHtml(total)}</td></tr></table>`
      : ''

  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:${INK};">Hi ${escapeHtml(i.recipientFirstName)},</p>
    <p style="margin:0 0 8px;font-size:16px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(lead)}</p>
    ${table}
    ${replyBy ? `<p style="margin:12px 0 4px;font-size:14px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(replyBy)}</p>` : ''}
    <p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(RULE_SENTENCE)}</p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(ask)}</p>`
  const after = `${renderSecondaryButton(CHANGE_LABEL, i.changeUrl)}<p style="margin:12px 0 0;text-align:center;font-size:13px;line-height:1.5;color:${MUTED};"><a href="${escapeHtml(i.notThereUrl)}" style="color:${BRAND};">${escapeHtml(NOT_THERE_LABEL)}</a></p><p style="margin:8px 0 0;text-align:center;font-size:13px;line-height:1.5;color:${MUTED};">Prefer to sign in? <a href="${escapeHtml(i.appUrl)}" style="color:${BRAND};">Open this receipt in the app</a>.</p>`
  const footerLine = `You're getting this because ${i.payerName} added ${i.receiptTitle} on ${i.tripName}. ${OFF_LINE}`
  const html = renderBrandedEmail({ bodyHtml: body, ctaLabel: DONE_LABEL, ctaUrl: i.doneUrl, footerLine, afterCtaHtml: after })

  const text = [
    `Hi ${i.recipientFirstName},`,
    '',
    lead,
    ...(i.items.length > 0 ? ['', ...i.items.map((it) => `- ${it.name}${itemSuffix(it)}: ${money(it.amountMinor, i.currency)}`), `Your total: ${total}`] : []),
    '',
    ...(replyBy ? [replyBy] : []),
    RULE_SENTENCE,
    ask,
    '',
    `${DONE_LABEL}: ${i.doneUrl}`,
    `${CHANGE_LABEL}: ${i.changeUrl}`,
    `${NOT_THERE_LABEL}: ${i.notThereUrl}`,
    `Or open this receipt in the app: ${i.appUrl}`,
    '',
    footerLine,
  ].join('\n')
  return { subject, html, text }
}

export interface ResultEmailInput {
  recipientFirstName: string
  receiptTitle: string
  tripName: string
  currency: string
  leftoverMinor: number
  totalMinor: number
  appUrl: string
  /** The recipient had said "That's everything": then they got their part of what was left over after everyone else's even shares. */
  recipientConfirmed?: boolean
  /** The receipt was closed before its deadline (the payer shared the rest early). */
  closedEarly?: boolean
}

/** True when the receipt was closed before its deadline (both ISO strings; anything unparsable counts as not early). */
export function closedEarly(deadlineIso: string | null | undefined, closedIso: string | null | undefined): boolean {
  const d = deadlineIso ? Date.parse(deadlineIso) : NaN
  const c = closedIso ? Date.parse(closedIso) : NaN
  return Number.isFinite(d) && Number.isFinite(c) && c < d - 60_000
}

export function resultEmailSubject(i: Pick<ResultEmailInput, 'receiptTitle' | 'tripName' | 'currency' | 'leftoverMinor'>): string {
  return oneLine(`${money(i.leftoverMinor, i.currency)} of unclaimed items on ${i.receiptTitle} was added to you — ${i.tripName}`)
}

export function renderResultEmail(i: ResultEmailInput): RenderedNotice {
  const lead = `${i.closedEarly ? 'The rest was shared early' : 'The deadline passed'} — ${money(i.leftoverMinor, i.currency)} of unclaimed items from ${i.receiptTitle} was added to your share (now ${money(i.totalMinor, i.currency)}).`
  const why = i.recipientConfirmed
    ? "What was left after everyone's even shares was shared by everyone, including people who had said 'That's everything'."
    : "It was shared between people who had not said 'That's everything', never more than an even share each."
  const how = `${why} You can change your items in the app until balances are frozen.`
  const body = `
    <p style="margin:0 0 12px;font-size:15px;color:${INK};">Hi ${escapeHtml(i.recipientFirstName)},</p>
    <p style="margin:0 0 8px;font-size:16px;line-height:1.5;color:${INK};font-weight:600;">${escapeHtml(lead)}</p>
    <p style="margin:0;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(how)}</p>`
  const footerLine = `You're getting this because unclaimed items on ${i.receiptTitle} (${i.tripName}) were shared. ${OFF_LINE}`
  const html = renderBrandedEmail({ bodyHtml: body, ctaLabel: 'Open the receipt', ctaUrl: i.appUrl, footerLine })
  const text = [`Hi ${i.recipientFirstName},`, '', lead, how, '', `Open the receipt: ${i.appUrl}`, '', footerLine].join('\n')
  return { subject: resultEmailSubject(i), html, text }
}

// ---------------------------------------------------------------------------
// Database answers -> HTTP answers (receipt-notice)
// ---------------------------------------------------------------------------

/** The function does not exist yet (migration B not applied): PostgREST PGRST202, Postgres 42883, or the matching message. */
export function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883' || /could not find the function|function .* does not exist/i.test(error.message ?? '')
}

export type RpcFailure = { status: number; body: { success: false; reason: string } | { success: false; error: string } }

/** Maps an error from send_receipt_to_table (hints in interface note 2A) to the HTTP answer. Never echoes the database message. */
export function mapSendRpcError(error: { code?: string; message?: string; hint?: string } | null | undefined): RpcFailure {
  if (isMissingFunction(error)) return { status: 409, body: { success: false, reason: 'not_available' } }
  const hint = (error?.hint ?? '').toLowerCase()
  if (hint === 'auth') return { status: 401, body: { success: false, error: 'Unauthorized' } }
  if (hint === 'forbidden' || hint === 'not_found') return { status: 403, body: { success: false, error: 'Forbidden' } }
  if (hint === 'closed' || hint === 'claims_closed') return { status: 409, body: { success: false, reason: 'claims_closed' } } // renamed in the database; the old spelling is still understood
  if (['not_itemised', 'frozen', 'deadline_passed', 'bad_deadline', 'not_sent'].includes(hint)) return { status: 409, body: { success: false, reason: hint } }
  if (error?.code === '22023') return { status: 409, body: { success: false, reason: 'bad_deadline' } }
  if (error?.code === '42501') return { status: 403, body: { success: false, error: 'Forbidden' } }
  return { status: 502, body: { success: false, reason: 'state_failed' } }
}

export interface RecipientOutcome {
  sent: boolean
  reason: ReceiptSkipReason | 'send_failed' | 'token_failed' | 'state_failed' | null
}

const OUR_FAILURES = new Set(['send_failed', 'token_failed', 'state_failed'])

/** Folds the per-recipient outcomes into the response: only counts, never which recipient or why (except our own failures). */
export function summariseSendOutcomes(outcomes: RecipientOutcome[]): { status: number; body: Record<string, unknown> } {
  const sent = outcomes.filter((o) => o.sent).length
  const failures = outcomes.filter((o) => !o.sent && OUR_FAILURES.has(o.reason ?? ''))
  // "Already told" = got this email (or its latest version) on an earlier call: a retry skips them without sending or counting a cap.
  const alreadyTold = outcomes.filter((o) => !o.sent && o.reason === 'already_sent').length
  const skipped = outcomes.length - sent - failures.length - alreadyTold
  // No email provider configured: every attempted recipient hit the same wall. Lets the app say "emails aren't set up".
  const emailConfigured = !(outcomes.length > 0 && outcomes.every((o) => o.reason === 'no_channel'))
  const counts = { sent, already_told: alreadyTold, skipped, failed: failures.length, email_configured: emailConfigured }
  if (sent === 0 && failures.length > 0) return { status: 502, body: { success: false, reason: failures[0].reason, ...counts } }
  if (sent === 0 && outcomes.length > 0 && outcomes.every((o) => o.reason === 'capped')) return { status: 409, body: { success: false, reason: 'capped' } }
  return { status: 200, body: { success: true, ...counts } }
}

// ---------------------------------------------------------------------------
// The public page (receipt-claim)
// ---------------------------------------------------------------------------

export type ClaimAction = 'done' | 'not_there' | 'undo_done' | 'toggle'
export type ClaimPageState = 'ok' | 'refused' | 'expired' | 'revoked' | 'invalid' | 'unavailable'

export const REFUSAL_REASONS = [
  'frozen',
  'claims_closed',
  'deadline_passed',
  'not_open',
  'not_itemised',
  'not_on_receipt',
  'payer',
  'has_claims',
  'has_leftovers',
  'forbidden',
  'too_many_sharers',
  'bad_action',
  'bad_payload',
  'bad_line',
  'error',
] as const

/** Plain-language message for each refusal reason / `closed_reason` (the page may show it as is). */
export const REASON_MESSAGES: Record<string, string> = {
  frozen: 'Balances are frozen for this trip, so this receipt can no longer be changed.',
  claims_closed: "The unclaimed items on this receipt have already been shared out. Ask the person who paid if something's wrong.",
  deadline_passed: 'The deadline for this receipt has passed.',
  not_open: "This receipt isn't open for claims yet.",
  not_itemised: "This expense isn't an itemised receipt any more.",
  not_on_receipt: "You're not on this receipt.",
  payer: 'The person who paid is always on the receipt.',
  has_claims: "Take yourself off your items first, then say you weren't there.",
  has_leftovers: 'The person who paid gave the rest of this receipt to you. Ask them to change that first.',
  forbidden: "You can't change that.",
  too_many_sharers: "That item is already shared in a way that can't be split any further.",
  bad_action: "That didn't work. Please try again.",
  bad_payload: "That didn't work. Please try again.",
  bad_line: "That item isn't on this receipt any more. Refresh and try again.",
  error: "That didn't work. Please try again.",
}
/** An old spelling the database no longer sends, mapped to the current reason. */
const normaliseReason = (r: string) => (r === 'closed' ? 'claims_closed' : r)

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The peek payload without its `result` key; the database already scopes it to the person behind the token. */
function receiptPayload(state: unknown): Record<string, unknown> | null {
  if (!isObj(state) || state.result !== 'ok' || !isObj(state.expense)) return null
  const { result: _result, ...rest } = state
  return rest
}

const TOKEN_PROBLEM: Record<string, ClaimPageState> = { expired: 'expired', revoked: 'revoked', not_found: 'invalid' }

/** Answer for `peek`. Anything unexpected is 'invalid' (same as an unknown token). */
export function mapPeekResult(data: unknown): { status: number; body: Record<string, unknown> } {
  const p = receiptPayload(data)
  if (p) {
    // `editable:false` comes with a closed_reason: say it in words too.
    const reason = typeof p.closed_reason === 'string' ? normaliseReason(p.closed_reason) : null
    const message = reason ? REASON_MESSAGES[reason] ?? REASON_MESSAGES.error : null
    return { status: 200, body: { state: 'ok', receipt: reason ? { ...p, closed_reason: reason } : p, ...(message ? { message } : {}) } }
  }
  const r = isObj(data) && typeof data.result === 'string' ? data.result : ''
  return { status: 200, body: { state: TOKEN_PROBLEM[r] ?? 'invalid' } }
}

/** Answer for an action: ok / refused (with the current truth to render) / token problems. */
export function mapActResult(data: unknown, action: string): { status: number; body: Record<string, unknown> } {
  if (!isObj(data)) return { status: 200, body: { state: 'invalid' } }
  if (data.result === 'ok') {
    const p = receiptPayload(data.state)
    if (!p) return { status: 200, body: { state: 'invalid' } }
    return { status: 200, body: { state: 'ok', action, changed: data.changed === true, receipt: p } }
  }
  if (data.result === 'refused') {
    const rawReason = typeof data.reason === 'string' ? normaliseReason(data.reason) : ''
    const reason = (REFUSAL_REASONS as readonly string[]).includes(rawReason) ? rawReason : 'error'
    const p = receiptPayload(data.state)
    const cr = p && typeof p.closed_reason === 'string' ? normaliseReason(p.closed_reason) : null
    const message = REASON_MESSAGES[reason] && reason !== 'error' ? REASON_MESSAGES[reason] : typeof data.message === 'string' && data.message ? oneLine(data.message).slice(0, 200) : REASON_MESSAGES.error
    return {
      status: 200,
      body: { state: 'refused', action, reason, message, ...(p ? { receipt: cr ? { ...p, closed_reason: cr } : p } : {}) },
    }
  }
  const r = typeof data.result === 'string' ? data.result : ''
  return { status: 200, body: { state: TOKEN_PROBLEM[r] ?? 'invalid' } }
}

/** Rate-limit key material: hashed before it is sent to the database, so neither an IP nor a token ever sits in a table. */
export function rateKey(kind: 'ip' | 'tok', value: string, write: boolean): string {
  return `receipt:${kind}:${value}${write ? ':post' : ''}`
}
