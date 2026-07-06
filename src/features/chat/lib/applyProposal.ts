import { supabase } from '../../../lib/supabase'
import { largestRemainderDistribute, toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { ProposedActionSchema, type ProposedAction } from '../../../shared/contracts/aiProposal'
import type { Json } from '../../../types/database.types'

/**
 * Client-side application of approved AI proposal actions (plan §13.2/3):
 * every write runs under the approving user's JWT so RLS is the
 * enforcement layer — the AI can never cause anything its human approver
 * couldn't do by hand. Nothing here uses the service role.
 */

// ---------------------------------------------------------------------------
// Parsing (validation preview — invalid actions are flagged, never dropped)
// ---------------------------------------------------------------------------

export interface ParsedActionEntry {
  /** Stable identity for per-card state; falls back to index when the raw is too broken to carry a key. */
  key: string
  raw: unknown
  action: ProposedAction | null
  /** Zod validation error summary when action is null. */
  error: string | null
}

export function parseProposalActions(rawActions: Json): ParsedActionEntry[] {
  const list = Array.isArray(rawActions) ? rawActions : []
  return list.map((raw, index) => {
    const result = ProposedActionSchema.safeParse(raw)
    const fallbackKey =
      typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).idempotency_key === 'string'
        ? ((raw as Record<string, unknown>).idempotency_key as string)
        : `invalid-${index}`
    if (result.success) {
      return { key: result.data.idempotency_key, raw, action: result.data, error: null }
    }
    const issue = result.error.issues[0]
    return {
      key: fallbackKey,
      raw,
      action: null,
      error: issue ? `${issue.path.join('.') || 'action'}: ${issue.message}` : 'Invalid action',
    }
  })
}

// ---------------------------------------------------------------------------
// Descriptions (review cards)
// ---------------------------------------------------------------------------

export interface ActionDescription {
  icon: string
  /** e.g. "Add itinerary event". */
  title: string
  /** e.g. `"Dinner at Kumo" — Sat 14 Mar, 19:00`. */
  summary: string
  /** Where it lands: "Itinerary", "Decisions", "Bookings", "Expenses". */
  target: string
  isDelete: boolean
}

export function describeAction(action: ProposedAction): ActionDescription {
  switch (action.type) {
    case 'create_event':
      return {
        icon: '📅',
        title: 'Add itinerary event',
        summary: `"${action.title}" — ${action.event_date}${action.start_time ? `, ${action.start_time}` : ''}${action.location ? ` · ${action.location}` : ''}`,
        target: 'Itinerary',
        isDelete: false,
      }
    case 'create_option':
      return {
        icon: '💡',
        title: 'Add option',
        summary: `"${action.title}"${action.price != null ? ` — ${action.currency ?? ''} ${action.price}`.trimEnd() : ''}`,
        target: 'Decisions',
        isDelete: false,
      }
    case 'create_booking_draft':
      return {
        icon: '🧾',
        title: 'Track booking',
        summary: `"${action.title}"${action.vendor ? ` via ${action.vendor}` : ''}${action.amount != null ? ` — ${action.currency ?? ''} ${action.amount}`.trimEnd() : ''}`,
        target: 'Bookings',
        isDelete: false,
      }
    case 'create_expense_draft':
      return {
        icon: '💰',
        title: 'Add expense',
        summary: `"${action.description}" — ${action.currency} ${action.amount}${action.participant_ids?.length ? ` · ${action.participant_ids.length} people` : ''}`,
        target: 'Expenses',
        isDelete: false,
      }
    case 'update_event':
      return {
        icon: '✏️',
        title: 'Update itinerary event',
        summary: [
          action.title ? `title → "${action.title}"` : null,
          action.event_date ? `date → ${action.event_date}` : null,
          action.start_time !== undefined ? `time → ${action.start_time ?? 'cleared'}` : null,
          action.location !== undefined ? `location → ${action.location ?? 'cleared'}` : null,
        ]
          .filter(Boolean)
          .join(', ') || 'No field changes',
        target: 'Itinerary',
        isDelete: false,
      }
    case 'delete_request':
      return {
        icon: '🗑️',
        title: `Delete ${action.entity_type.replace(/_/g, ' ')}`,
        summary: action.reason || 'The AI suggests deleting this — confirm individually.',
        target: 'Danger zone',
        isDelete: true,
      }
  }
}

// ---------------------------------------------------------------------------
// Idempotency: applied keys survive reloads so re-opening a proposal never
// double-applies (localStorage per proposal; the proposal status flip to
// approved/partially_applied is the cross-device backstop).
// ---------------------------------------------------------------------------

function appliedStorageKey(proposalId: string): string {
  return `proposal-applied:${proposalId}`
}

export function loadAppliedKeys(proposalId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(appliedStorageKey(proposalId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveAppliedKey(proposalId: string, idempotencyKey: string): void {
  try {
    const keys = loadAppliedKeys(proposalId)
    keys.add(idempotencyKey)
    window.localStorage.setItem(appliedStorageKey(proposalId), JSON.stringify([...keys]))
  } catch {
    // Storage unavailable — the in-memory card state still prevents double-apply this session.
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyContext {
  tripId: string
  /** The approving user — payer/creator defaults. */
  userId: string
  baseCurrency: string
}

const DELETE_TABLES: Record<string, string> = {
  event: 'trip_timeline_events',
  option: 'options',
  booking: 'bookings',
  expense: 'expenses',
  checklist_item: 'trip_checklists',
}

/**
 * Apply ONE approved action under the current user's JWT. Throws on
 * failure (RLS denial, FK violation, network) — callers mark the card
 * errored and keep going with the rest of the batch.
 */
export async function applyAction(action: ProposedAction, ctx: ApplyContext): Promise<void> {
  switch (action.type) {
    case 'create_event': {
      const { error } = await supabase.from('trip_timeline_events').insert({
        trip_id: ctx.tripId,
        created_by: ctx.userId,
        title: action.title,
        event_date: action.event_date,
        start_time: action.start_time ?? null,
        end_time: action.end_time ?? null,
        all_day: action.all_day ?? null,
        category: action.category ?? 'other',
        location: action.location ?? null,
        description: action.description ?? null,
      })
      if (error) throw new Error(error.message)
      return
    }
    case 'create_option': {
      const { error } = await supabase.from('options').insert({
        section_id: action.section_id,
        title: action.title,
        description: action.description ?? null,
        price: action.price ?? null,
        currency: action.currency ?? null,
        price_type: action.price_type ?? undefined,
      })
      if (error) throw new Error(error.message)
      return
    }
    case 'create_booking_draft': {
      const { error } = await supabase.from('bookings').insert({
        trip_id: ctx.tripId,
        booked_by: ctx.userId,
        option_id: action.option_id ?? null,
        title: action.title,
        vendor: action.vendor ?? null,
        confirmation_ref: action.confirmation_ref ?? null,
        amount: action.amount ?? null,
        currency: action.currency ?? ctx.baseCurrency,
        booking_date: action.booking_date ?? null,
        cancellation_deadline: action.cancellation_deadline ?? null,
        status: 'reserved',
      })
      if (error) throw new Error(error.message)
      return
    }
    case 'create_expense_draft': {
      const paidBy = action.paid_by ?? ctx.userId
      const participantIds = action.participant_ids?.length ? action.participant_ids : [paidBy]
      const { data: expense, error } = await supabase
        .from('expenses')
        .insert({
          trip_id: ctx.tripId,
          description: action.description,
          amount: action.amount,
          currency: action.currency,
          paid_by: paidBy,
          payment_date: action.payment_date ?? new Date().toISOString().slice(0, 10),
          category: action.category ?? 'other',
          participant_ids: participantIds,
        })
        .select()
        .single()
      if (error) throw new Error(error.message)

      // Equal splits among tagged participants via the money module (exact-sum).
      const totalMinor = toMinorUnits(action.amount, action.currency)
      const shares = largestRemainderDistribute(totalMinor, participantIds.map(() => 1))
      const splitRows = participantIds.map((userId, i) => ({
        expense_id: expense.id,
        user_id: userId,
        amount: fromMinorUnits(shares[i], action.currency),
        split_type: 'equal' as const,
      }))
      const { error: splitsError } = await supabase.from('expense_splits').insert(splitRows)
      if (splitsError) {
        // Roll back the orphaned expense so a partial apply doesn't corrupt balances.
        await supabase.from('expenses').delete().eq('id', expense.id)
        throw new Error(splitsError.message)
      }
      return
    }
    case 'update_event': {
      const update: Record<string, unknown> = {}
      if (action.title !== undefined) update.title = action.title
      if (action.event_date !== undefined) update.event_date = action.event_date
      if (action.start_time !== undefined) update.start_time = action.start_time
      if (action.end_time !== undefined) update.end_time = action.end_time
      if (action.location !== undefined) update.location = action.location
      if (action.description !== undefined) update.description = action.description
      if (Object.keys(update).length === 0) return
      update.updated_at = new Date().toISOString()
      const { error } = await supabase.from('trip_timeline_events').update(update).eq('id', action.event_id)
      if (error) throw new Error(error.message)
      return
    }
    case 'delete_request': {
      // Only ever reached from the per-card individual confirm (never bulk).
      const table = DELETE_TABLES[action.entity_type]
      if (!table) throw new Error(`Unknown entity type: ${action.entity_type}`)
      const { error } = await supabase
        .from(table as 'trip_timeline_events')
        .delete()
        .eq('id', action.entity_id)
      if (error) throw new Error(error.message)
      return
    }
  }
}
