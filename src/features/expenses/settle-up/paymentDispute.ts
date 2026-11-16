import type { Settlement } from '../../../lib/queries/useSettlements'
import type { ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'

/**
 * "It hasn't arrived": what each person sees and may do on a payment row.
 * Pure. The state lives in `settlements.receipt_disputed_at` (20261121090000_payment_receipt_dispute.sql).
 */
export const MAX_RE_ASKS = 2
export const RE_ASKED_VERB = 'settlement_re_asked'

export const RETRACT_CONFIRM_TITLE = 'This undoes "marked as paid".'
/** `onBehalf`: an organizer recorded this payment as paid for the payer (so undoing it corrects THEIR entry). */
export const retractConfirmBody = (receiverName: string, onBehalf = false) =>
  onBehalf
    ? `An organizer recorded this payment as paid for you. Undoing it puts it back to unpaid, and ${receiverName} will be told.`
    : `${receiverName} will be told.`

/** Settle up: shown (and Freeze / Unfreeze paused) while any payment is flagged "hasn't arrived". */
export const DISPUTED_PAYMENT_PAUSE = 'A payment is in question — sort that out first'

/**
 * Payments the receiver has flagged "hasn't arrived" and nobody has answered.
 *
 * NOTE (kept on purpose): a flagged payment STILL COUNTS AS SENT in the money maths (withSentPaymentsCounted, the freeze
 * suggestions, the Money header). Un-counting it would make a refreeze insert a second suggestion for the same debt while
 * the marked_paid row exists, and the payer could end up asked to pay twice if the money does turn up. The explicit way
 * back is the payer's "Undo" (back to suggested), after which a refreeze recomputes the debt correctly. To stop a
 * payer who never answers from hiding the debt forever, Freeze/Unfreeze are paused while one exists (UI guard only) and
 * organizers see it in Waiting on once it is older than DISPUTE_NUDGE_DAYS.
 */
export function disputedPayments<T extends { status: string; receipt_disputed_at?: string | null }>(rows: ReadonlyArray<T>): T[] {
  return rows.filter((r) => r.status === 'marked_paid' && !!r.receipt_disputed_at)
}
export const DISPUTE_NUDGE_DAYS = 3
export const ASK_ORGANIZER_TEXT = 'Ask an organizer to help'
export const askedAgainNote = (receiverName: string) => `We've asked ${receiverName} to check again`

type Row = Pick<Settlement, 'id' | 'status' | 'from_user_id' | 'to_user_id'> & { receipt_disputed_at?: string | null }

/** The database has the column once any row carries the key (select('*') omits it before the migration). */
export function disputeSupported(rows: ReadonlyArray<object>): boolean {
  return rows.some((r) => 'receipt_disputed_at' in r)
}

export function isDisputed(row: Pick<Row, 'receipt_disputed_at'>): boolean {
  return !!row.receipt_disputed_at
}

/**
 * How many times the payer asked again for this payment. Only rows written by the payer or someone who
 * can manage the trip count (anyone on the trip can insert activity rows with another or no actor).
 */
export function reAsksUsed(entries: ReadonlyArray<ActivityFeedEntry>, row: Pick<Row, 'id' | 'from_user_id'>, managerIds: ReadonlySet<string>): number {
  let n = 0
  for (const e of entries) {
    if (e.verb !== RE_ASKED_VERB || !e.actor) continue
    const entity = e.entity && typeof e.entity === 'object' && !Array.isArray(e.entity) ? (e.entity as { id?: unknown }) : null
    if (entity?.id !== row.id) continue
    if (e.actor === row.from_user_id || managerIds.has(e.actor)) n++
  }
  return n
}

export const reAsksLeft = (used: number) => Math.max(0, MAX_RE_ASKS - used)

export type DisputeAction = 'not_arrived' | 'ask_again' | 'retract'

export interface DisputeViewer {
  viewerId: string | undefined
  canManageTrip: boolean
}

export interface DisputeView {
  /** Status line for this viewer, or null. */
  statusLine: string | null
  actions: DisputeAction[]
  /** Plain text shown instead of a button (payer, no re-asks left). */
  helpText: string | null
}

const NONE: DisputeView = { statusLine: null, actions: [], helpText: null }

export const ACTION_LABELS: Record<DisputeAction, string> = {
  not_arrived: "It hasn't arrived",
  ask_again: "I've sent it — ask again",
  retract: "Undo — I haven't paid yet",
}

export function disputeView(
  row: Row,
  viewer: DisputeViewer,
  opts: { supported: boolean; reAsksUsed: number; payerName: string; receiverName: string }
): DisputeView {
  if (!opts.supported || row.status !== 'marked_paid' || !viewer.viewerId) return NONE
  const isReceiver = viewer.viewerId === row.to_user_id
  const isPayer = viewer.viewerId === row.from_user_id
  const disputed = isDisputed(row)
  if (!disputed) {
    if (isReceiver) return { statusLine: null, actions: ['not_arrived'], helpText: null }
    // The payer may always take back a payment they marked paid (the database allows it), flagged or not:
    // "I marked it paid by mistake". Quiet: no status line.
    return isPayer ? { statusLine: null, actions: ['retract'], helpText: null } : NONE
  }
  const statusLine = isReceiver ? `You said this hasn't arrived — waiting for ${opts.payerName}` : `${opts.receiverName} says this hasn't arrived`
  const mayAct = isPayer || viewer.canManageTrip
  if (!mayAct) return { statusLine, actions: [], helpText: null }
  const actions: DisputeAction[] = []
  let helpText: string | null = null
  if (reAsksLeft(opts.reAsksUsed) > 0) actions.push('ask_again')
  else if (isPayer && !viewer.canManageTrip) helpText = ASK_ORGANIZER_TEXT
  actions.push('retract')
  return { statusLine, actions, helpText }
}
