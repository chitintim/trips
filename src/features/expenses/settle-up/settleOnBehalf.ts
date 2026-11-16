import type { Settlement } from '../../../lib/queries/useSettlements'
import type { ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'

/**
 * Pure rules for "Settle on their behalf": people who can manage the trip
 * (active organiser, trip creator or site admin) closing out payments that
 * the parties never came back to record. Nothing here talks to the server.
 *
 * Server note: no migration is needed for organisers on the roster. The live
 * guard trigger (guard_settlement_party_update) returns early for
 * is_trip_organizer(), and the UPDATE policy admits them, so their direct
 * status update is allowed. A creator or site admin who is NOT on the roster
 * is refused by that same policy; the UI reports that per row.
 */

export const ON_BEHALF_VERB = 'settlement_recorded_on_behalf'

export type OnBehalfKind = 'record_paid' | 'record_paid_and_received' | 'confirm_received'

export interface OnBehalfAction {
  kind: OnBehalfKind
  /** The status the row moves to. */
  to: 'marked_paid' | 'confirmed'
  label: string
}

export interface OnBehalfContext {
  canManageTrip: boolean
  viewerId: string | undefined
  /** Receiver's display name, for the "Confirm received on <name>'s behalf" label. */
  receiverName: string
}

/**
 * Which on-behalf actions the "..." menu offers on one payment row.
 * - suggested: "Record as paid" (skipped for the payer, who has their own
 *   Mark paid button) and "Record as paid and received".
 * - marked_paid: "Confirm received on <receiver>'s behalf" (skipped for the
 *   receiver, who has their own Confirm received button).
 * - confirmed or anything else: nothing.
 */
export function onBehalfActions(s: Pick<Settlement, 'status' | 'from_user_id' | 'to_user_id'>, ctx: OnBehalfContext): OnBehalfAction[] {
  if (!ctx.canManageTrip) return []
  if (s.status === 'suggested') {
    const out: OnBehalfAction[] = []
    if (s.from_user_id !== ctx.viewerId) out.push({ kind: 'record_paid', to: 'marked_paid', label: 'Record as paid' })
    out.push({ kind: 'record_paid_and_received', to: 'confirmed', label: 'Record as paid and received' })
    return out
  }
  if (s.status === 'marked_paid') {
    if (s.to_user_id === ctx.viewerId) return []
    return [{ kind: 'confirm_received', to: 'confirmed', label: `Confirm received on ${ctx.receiverName}'s behalf` }]
  }
  return []
}

export interface SettleAllRow {
  id: string
  fromUserId: string
  toUserId: string
  fromName: string
  toName: string
  amount: number
  currency: string
  status: 'suggested' | 'marked_paid'
}

export interface SettleAllList {
  rows: SettleAllRow[]
  count: number
  /** One entry per currency (a trip's payments are normally all in the base currency). */
  totals: Array<{ currency: string; amount: number }>
}

/** Every unfinished payment (suggested or marked paid), oldest first, with the count and total per currency. */
export function buildSettleAllList(settlements: Settlement[], nameOf: (userId: string) => string, baseCurrency: string): SettleAllList {
  const rows: SettleAllRow[] = settlements
    .filter((s) => s.status === 'suggested' || s.status === 'marked_paid')
    .slice()
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.id.localeCompare(b.id))
    .map((s) => ({
      id: s.id,
      fromUserId: s.from_user_id,
      toUserId: s.to_user_id,
      fromName: nameOf(s.from_user_id),
      toName: nameOf(s.to_user_id),
      amount: s.amount,
      currency: s.currency ?? baseCurrency,
      status: s.status as 'suggested' | 'marked_paid',
    }))
  const byCurrency = new Map<string, number>()
  for (const r of rows) byCurrency.set(r.currency, Math.round(((byCurrency.get(r.currency) ?? 0) + r.amount) * 100) / 100)
  return { rows, count: rows.length, totals: Array.from(byCurrency, ([currency, amount]) => ({ currency, amount })) }
}

/** "Mark everything as settled…" is for a frozen trip, for people who can manage it, when something is unfinished and no duplicate is unresolved. */
export function canOfferSettleAll(opts: { canManageTrip: boolean; isFrozen: boolean; unfinishedCount: number }): boolean {
  return opts.canManageTrip && opts.isFrozen && opts.unfinishedCount > 0
}

export function settleAllConfirmLabel(count: number): string {
  return `Mark ${count} ${count === 1 ? 'payment' : 'payments'} as settled`
}

export const SETTLE_ALL_WARNING =
  "Only do this if these have really been paid. It records each as paid and received on their behalf, and it's logged under your name."

export const STATUS_PHRASE: Record<SettleAllRow['status'], string> = { suggested: 'not yet paid', marked_paid: 'marked paid, not confirmed' }

/** True when there is at least one payment and every one is confirmed. */
export function isEverythingSettled(settlements: Pick<Settlement, 'status'>[]): boolean {
  return settlements.length > 0 && settlements.every((s) => s.status === 'confirmed')
}

export interface OnBehalfRecord {
  actorId: string | null
  at: string
  fromStatus: string | null
  toStatus: string | null
}

function metaOf(e: ActivityFeedEntry): Record<string, unknown> {
  return e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata) ? (e.metadata as Record<string, unknown>) : {}
}

/** Latest on-behalf activity entry per settlement id (entity.id), from the activity feed. */
export function onBehalfRecordsBySettlement(entries: ActivityFeedEntry[]): Map<string, OnBehalfRecord> {
  const out = new Map<string, OnBehalfRecord>()
  for (const e of entries) {
    if (e.verb !== ON_BEHALF_VERB) continue
    const entity = e.entity && typeof e.entity === 'object' && !Array.isArray(e.entity) ? (e.entity as { id?: unknown }) : null
    const id = typeof entity?.id === 'string' ? entity.id : null
    if (!id) continue
    const at = e.created_at ?? ''
    const prev = out.get(id)
    if (prev && prev.at >= at) continue
    const m = metaOf(e)
    out.set(id, {
      actorId: e.actor ?? null,
      at,
      fromStatus: typeof m.from_status === 'string' ? m.from_status : null,
      toStatus: typeof m.to_status === 'string' ? m.to_status : null,
    })
  }
  return out
}

/**
 * The "recorded by ..." line for a row, or null. Only shown while the row is
 * still in the state the organiser put it in (if the receiver later confirmed
 * it themselves, the row speaks for itself).
 */
export function onBehalfLabel(
  row: Pick<Settlement, 'status' | 'to_user_id'>,
  record: OnBehalfRecord | undefined,
  actorName: string,
  receiverName: string,
  formatDate: (iso: string) => string
): string | null {
  if (!record || !record.toStatus || record.toStatus !== row.status) return null
  const when = record.at ? ` on ${formatDate(record.at)}` : ''
  if (record.toStatus === 'confirmed') {
    return record.fromStatus === 'marked_paid'
      ? `Receipt confirmed on ${receiverName}'s behalf by ${actorName}${when}.`
      : `Recorded as paid and received by ${actorName}${when}, not by the people involved.`
  }
  return `Recorded as paid by ${actorName}${when}, not by the payer.`
}

/** Result of settling a list one by one: successes stay, failures are listed per row. */
export interface BatchOutcome {
  done: string[]
  failed: Array<{ id: string; message: string }>
}

export function summariseBatch(outcome: BatchOutcome): { tone: 'success' | 'warning' | 'error'; message: string } {
  const d = outcome.done.length
  const f = outcome.failed.length
  if (f === 0) return { tone: 'success', message: `${d} ${d === 1 ? 'payment' : 'payments'} marked as settled` }
  if (d === 0) return { tone: 'error', message: `Couldn't settle ${f === 1 ? 'the payment' : `any of the ${f} payments`}` }
  return { tone: 'warning', message: `${d} settled, ${f} failed` }
}
