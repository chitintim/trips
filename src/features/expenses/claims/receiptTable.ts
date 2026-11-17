/**
 * Receipts phase 2 on the signed-in screens: what exists yet (fail-soft probes), who has replied, and wording.
 * Pure so it is unit-tested; the hooks that fetch and write are in src/lib/queries/useReceiptTable.ts.
 *
 * FAIL-SOFT RULE: every control here appears only when the migration is there. Until then `receiptTableSupport`
 * says no for everything and the screens behave exactly as before.
 */
import { firstNameOf } from './claimPeople'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

/** The three expense columns, or null when the row has none of them (migration not applied). */
export interface ReceiptColumns {
  claimDeadline: string | null
  claimsSentAt: string | null
  claimsClosedAt: string | null
}

export function receiptColumnsOf(expense: object | null | undefined): ReceiptColumns | null {
  if (!expense) return null
  const e = expense as Record<string, unknown>
  if (!('claim_deadline' in e) || !('claims_sent_at' in e) || !('claims_closed_at' in e)) return null
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return { claimDeadline: s(e.claim_deadline), claimsSentAt: s(e.claims_sent_at), claimsClosedAt: s(e.claims_closed_at) }
}

export interface ReceiptTableRpcSupport {
  send: boolean
  extend: boolean
  apply: boolean
  /** `reopen_receipt_claims` exists: a closed receipt can be reopened. */
  reopen: boolean
  /** `respond_to_receipt` exists: "That's everything" / "I wasn't there" / Undo go through it (no direct table writes). */
  respond: boolean
}

export const NO_RPC_SUPPORT: ReceiptTableRpcSupport = { send: false, extend: false, apply: false, reopen: false, respond: false }

export type ReceiptPhase = 'unavailable' | 'draft' | 'open' | 'closed'

export interface ReceiptTableSupport {
  /** The payer can "Done — send to the table". */
  canSend: boolean
  /** People can reply "That's everything" / "I wasn't there". */
  canReply: boolean
  /** Deadline line, status, Extend, Share now. */
  hasStatus: boolean
  phase: ReceiptPhase
  columns: ReceiptColumns | null
  /** Why people cannot reply although the receipt is still open: the reply-by time has gone (the public page refuses the same way). */
  replyClosedReason: 'deadline_passed' | null
}

/** True once the reply-by time has gone. A receipt with no deadline never times out. */
export function deadlinePassed(deadline: string | null | undefined, now: Date): boolean {
  if (!deadline) return false
  const t = Date.parse(deadline)
  return Number.isFinite(t) && t <= now.getTime()
}

/**
 * What the screens may show. `responsesAvailable` = the expense_claim_responses table could be read.
 * Anything missing hides its controls; with the columns missing the phase is 'unavailable' and nothing new shows at all.
 */
export function receiptTableSupport(args: { expense: object | null | undefined; responsesAvailable: boolean; rpc: ReceiptTableRpcSupport; now?: Date }): ReceiptTableSupport {
  const columns = receiptColumnsOf(args.expense)
  if (!columns) return { canSend: false, canReply: false, hasStatus: false, phase: 'unavailable', columns: null, replyClosedReason: null }
  const phase: ReceiptPhase = columns.claimsClosedAt ? 'closed' : columns.claimsSentAt ? 'open' : 'draft'
  const late = phase === 'open' && deadlinePassed(columns.claimDeadline, args.now ?? new Date())
  return {
    canSend: args.rpc.send && phase === 'draft',
    canReply: args.rpc.respond && args.responsesAvailable && phase === 'open' && !late,
    hasStatus: phase === 'open' || phase === 'closed',
    phase,
    columns,
    replyClosedReason: late ? 'deadline_passed' : null,
  }
}

export type ReplyState = 'done' | 'not_there' | 'none'

export interface ReplyRow {
  userId: string
  name: string
  state: ReplyState
}

export interface ReplySummary {
  rows: ReplyRow[]
  replied: number
  total: number
}

/**
 * Everyone on the receipt except the payer (as the to-do counts it): who has replied and how. `peopleIds` must come from the shared
 * "who is on this receipt" rule, so `replied` / `total` equal the to-dos' "N of M have replied". People who said "I wasn't there" are no
 * longer on the receipt (so they are in neither count) but are still listed, last, so the payer can see why they dropped off.
 */
export function summarizeReplies(args: {
  peopleIds: ReadonlyArray<string>
  payerId: string
  responses: ReadonlyArray<{ expense_id: string; user_id: string; response: string }>
  expenseId: string
  participants: ParticipantWithUser[]
}): ReplySummary {
  const byUser = new Map<string, ReplyState>()
  for (const r of args.responses) {
    if (r.expense_id !== args.expenseId) continue
    byUser.set(r.user_id, r.response === 'done' ? 'done' : r.response === 'not_there' ? 'not_there' : 'none')
  }
  const row = (id: string): ReplyRow => {
    const p = args.participants.find((x) => x.user_id === id)
    return { userId: id, name: p ? firstNameOf(p) : 'Someone', state: byUser.get(id) ?? 'none' }
  }
  const onReceipt = args.peopleIds.filter((id) => id !== args.payerId).map(row)
  const listed = new Set(onReceipt.map((r) => r.userId))
  const wasntThere = [...byUser].filter(([id, st]) => st === 'not_there' && id !== args.payerId && !listed.has(id)).map(([id]) => row(id))
  return { rows: [...onReceipt, ...wasntThere], replied: onReceipt.filter((r) => r.state !== 'none').length, total: onReceipt.length }
}

export const REPLY_LABEL: Record<ReplyState, string> = { done: 'Done', not_there: "Wasn't there", none: 'Not yet' }

/**
 * The most people a send can email: on the receipt (the shared rule), not the person sending, not the payer (they never email themselves
 * about their own receipt), nobody who already said "That's everything". The server still skips people with no email, emails turned off, or
 * messaged a lot today, and people already told, so say "up to" (see `toTellLine`).
 */
export function countToTell(args: {
  peopleIds: ReadonlyArray<string>
  senderId: string
  payerId: string
  responses: ReadonlyArray<{ expense_id: string; user_id: string }>
  expenseId: string
}): number {
  const replied = new Set(args.responses.filter((r) => r.expense_id === args.expenseId).map((r) => r.user_id))
  return args.peopleIds.filter((id) => id !== args.senderId && id !== args.payerId && !replied.has(id)).length
}

/** The send sheet's promise: an upper bound, so the result line ("Sent to 3 ...") can never contradict it. */
export const toTellLine = (n: number): string => (n === 0 ? 'Nobody else to tell yet.' : `Up to ${n} ${n === 1 ? 'person' : 'people'} will be emailed.`)

export interface SendOutcome {
  ok: boolean
  sent: number
  skipped: number
  failed: number
  /** People who already had this email (a re-send): not skipped, just told already. 0 when the function does not report it. */
  alreadyTold: number
  /** false = no email provider is set up on the server (nothing can be emailed); null = the function did not say. */
  emailConfigured: boolean | null
  /** Machine reason when not ok (not_available, closed, frozen, deadline_passed, capped, send_failed, ...). */
  reason: string | null
}

export const EMAILS_NOT_SET_UP = "Emails aren't set up"

/** "N couldn't be sent — try again" (the button next to it retries; the call is safe to repeat). */
export const failedLine = (failed: number): string => `${failed} couldn't be sent — try again`

export const sentLine = (o: Pick<SendOutcome, 'sent' | 'skipped'> & { alreadyTold?: number; emailConfigured?: boolean | null }): string => {
  if (o.emailConfigured === false) return `${EMAILS_NOT_SET_UP}, so nobody was emailed. People will see it in the app.`
  const parts = [`Sent to ${o.sent} ${o.sent === 1 ? 'person' : 'people'}`]
  if (o.alreadyTold) parts.push(`${o.alreadyTold} already told`)
  if (o.skipped > 0) parts.push(`${o.skipped} skipped (no email, emails turned off, or emailed a lot today)`)
  return parts.join(' · ')
}

/**
 * After re-itemising a receipt that was already out at the table: what to tell the payer about the people whose claims were cleared
 * (they must look again; the app asks `receipt-notice` to email them). `outcome` null = the receipt was not out, so nobody is emailed.
 */
export function clearedPeopleLine(cleared: number, outcome: SendOutcome | null, reconfirm = 0): string {
  const parts: string[] = []
  if (cleared > 0) parts.push(cleared === 1 ? "1 person's claim was cleared." : `${cleared} people's claims were cleared.`)
  if (reconfirm > 0) parts.push(`${reconfirm} ${reconfirm === 1 ? 'person who' : 'people who'} said "That's everything" will be asked to check again.`)
  const who = parts.join(' ')
  if (!outcome) return who
  if (!outcome.ok) {
    return outcome.reason === 'deadline_passed'
      ? `${who} The reply time has passed so nobody was emailed. Extend it, then tap "Tell people what changed".`
      : `${who} We couldn't email them. Tap "Tell people what changed" to try again.`
  }
  const told =
    outcome.emailConfigured === false
      ? `${EMAILS_NOT_SET_UP}, so nobody was emailed. They'll see it in the app.`
      : outcome.sent > 0
        ? `We emailed ${outcome.sent} ${outcome.sent === 1 ? 'person' : 'people'} to look again.`
        : "Nobody could be emailed, so they'll see it in the app."
  return `${who} ${told}${outcome.failed > 0 ? ` ${failedLine(outcome.failed)}: tap "Tell people what changed".` : ''}`
}

export const OWN_CLAIM_CLEARED = 'Your claim on the changed item was cleared.'

/** Splits the people a re-itemise affected into "tell these" (everyone but the person editing) and whether the editor's own claim was cleared. */
export function peopleToTellAfterReitemise(clearedUserIds: string[], reconfirmUserIds: string[], meId: string | null | undefined) {
  const others = (ids: string[]) => [...new Set(ids)].filter((id) => id !== meId)
  return {
    clearedOthers: others(clearedUserIds),
    reconfirmOthers: others(reconfirmUserIds),
    ownClaimCleared: !!meId && clearedUserIds.includes(meId),
  }
}

/** The toast text after a re-itemise: counts and email wording are about other people only; the editor just hears about their own claim. */
export function reitemiseNoticeLine(told: ReturnType<typeof peopleToTellAfterReitemise>, outcome: SendOutcome | null): string | undefined {
  const others = told.clearedOthers.length > 0 || told.reconfirmOthers.length > 0 ? clearedPeopleLine(told.clearedOthers.length, outcome, told.reconfirmOthers.length) : ''
  const own = told.ownClaimCleared ? OWN_CLAIM_CLEARED : ''
  return [others, own].filter(Boolean).join(' ') || undefined
}

const SEND_REASON_COPY: Record<string, string> = {
  not_available: "Sending to the table isn't switched on yet.",
  not_itemised: "This expense isn't split by item.",
  frozen: 'Balances are frozen, so this can no longer be sent.',
  claims_closed: 'The leftovers were already shared, so this is closed. Reopen it to send it again.',
  closed: 'The leftovers were already shared, so this is closed. Reopen it to send it again.',
  deadline_passed: 'That reply time has already passed. Pick a later one.',
  bad_deadline: 'Pick a time in the future, within 90 days.',
  capped: 'Everyone was already messaged a lot today. Try again tomorrow.',
  send_failed: "The messages didn't go out. Try again.",
  token_failed: "The messages didn't go out. Try again.",
  state_failed: "The messages didn't go out. Try again.",
}

export function describeSendReason(reason: string | null): string {
  return (reason && SEND_REASON_COPY[reason]) || "Couldn't send this. Try again."
}

const TABLE_ERROR_BY_HINT: Record<string, string> = {
  claims_closed: "This receipt's claims are closed, so they can't be changed. Reopen it first.",
  closed: "This receipt's claims are closed, so they can't be changed. Reopen it first.",
  not_closed: 'This receipt is not closed.',
  has_leftovers: 'You were chosen to cover the leftovers on this receipt. Ask the person who paid to change that first.',
  frozen: 'Balances are frozen, so this can no longer be changed.',
  payer_not_there: "You paid for this, so you can't say you weren't there.",
  has_claims: "You've got items on this receipt, so take them off first.",
  deadline_passed: 'The time to reply has passed.',
  bad_input: "That answer wasn't understood. Try again.",
  bad_deadline: 'Pick a time in the future, within 90 days.',
  not_sent: "This receipt hasn't been sent to the table yet.",
  forbidden: 'Only the person who paid or an organizer can do this.',
  not_found: "This receipt can't be found any more.",
  not_itemised: "This expense isn't split by item.",
  auth: 'Please sign in again.',
}

export function describeTableError(err: unknown, fallback = 'Something went wrong. Try again.', payerName?: string): string {
  const hint = err && typeof err === 'object' ? (err as { hint?: unknown }).hint : null
  if (hint === 'has_leftovers' && payerName) return `You were chosen to cover the leftovers on this receipt. Ask ${payerName} to change that first.`
  if (typeof hint === 'string' && TABLE_ERROR_BY_HINT[hint]) return TABLE_ERROR_BY_HINT[hint]
  return fallback
}

export const STATUS_COPY = {
  sent: (day: string, replied: number, total: number) => `Sent · reply by ${day} · ${replied} of ${total} have replied`,
  sentNoCount: (day: string) => `Sent · reply by ${day}`,
  closed: (day: string) => `Closed on ${day}`,
  closedLeftovers: (day: string, text: string) => `Closed on ${day} · leftovers shared: ${text}`,
  extend: 'Extend',
  shareNow: 'Share the rest now',
  resend: 'Tell people what changed',
  reopen: 'Reopen',
} as const

/** Quick extension choices (days). The new deadline keeps 18:00 UTC. */
export const EXTEND_DAYS = [1, 3, 7] as const

/** What `receipt-notice` answered, as the sheet needs it. `status` null = the request never got an answer. */
export function sendOutcomeFrom(status: number | null, body: unknown): SendOutcome {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const reason = typeof b.reason === 'string' ? b.reason : null
  const counts = { sent: n(b.sent), skipped: n(b.skipped), failed: n(b.failed), alreadyTold: n(b.already_told) }
  const emailConfigured = typeof b.email_configured === 'boolean' ? b.email_configured : null
  if (status === 200 && b.success === true) return { ok: true, ...counts, emailConfigured, reason: null }
  return { ok: false, ...counts, emailConfigured, reason: reason ?? (status === 409 ? 'not_available' : null) }
}
