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

/**
 * Optional id -> title lookups so review cards can name the option/section
 * an update_option/move_option/update_section action targets, instead of a
 * bare UUID. `sectionTitles` should also carry an entry keyed by
 * `ref:<idempotency_key>` for every create_section action in the SAME
 * proposal batch, so a move_option/create_option that targets a
 * not-yet-applied new section still shows its question wording (see
 * ProposalReview.tsx, which builds both maps). Omitted entirely by callers
 * that don't have trip data handy (e.g. the auto-apply toast) — falls back
 * to whatever the action itself carries.
 */
export interface DescribeContext {
  optionTitles?: Map<string, string>
  sectionTitles?: Map<string, string>
}

export function describeAction(action: ProposedAction, ctx: DescribeContext = {}): ActionDescription {
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
    case 'update_option': {
      const target = ctx.optionTitles?.get(action.option_id)
      const fields = [
        action.title ? `title → "${action.title}"` : null,
        action.price !== undefined ? `price → ${action.price != null ? `${action.currency ?? ''} ${action.price}`.trim() : 'cleared'}` : null,
        action.description !== undefined ? `description ${action.description ? 'updated' : 'cleared'}` : null,
        action.metadata_patch ? 'details updated' : null,
      ]
        .filter(Boolean)
        .join(', ') || 'no field changes'
      return {
        icon: '✏️',
        title: 'Update option',
        summary: `"${target ?? action.title ?? 'Option'}" — ${fields}`,
        target: 'Decisions',
        isDelete: false,
      }
    }
    case 'create_section': {
      return {
        icon: '❔',
        title: 'New question',
        summary: `"${action.title}" (${action.decision_shape === 'personal' ? 'Personal picks' : 'Group vote'})`,
        target: 'Decisions',
        isDelete: false,
      }
    }
    case 'update_section': {
      const target = ctx.sectionTitles?.get(action.section_id)
      const fields = [
        action.title ? `title → "${action.title}"` : null,
        action.description !== undefined ? `description ${action.description ? 'updated' : 'cleared'}` : null,
        action.vote_deadline !== undefined ? `deadline → ${action.vote_deadline ?? 'cleared'}` : null,
        action.metadata_patch ? 'details updated' : null,
      ]
        .filter(Boolean)
        .join(', ') || 'no field changes'
      return {
        icon: '✏️',
        title: 'Update question',
        summary: `"${target ?? action.title ?? 'Question'}" — ${fields}`,
        target: 'Decisions',
        isDelete: false,
      }
    }
    case 'move_option': {
      const optionTitle = ctx.optionTitles?.get(action.option_id)
      const sectionTitle = ctx.sectionTitles?.get(action.to_section_id)
      return {
        icon: '➡️',
        title: 'Move option',
        summary: `${optionTitle ? `"${optionTitle}"` : 'Option'} → ${sectionTitle ? `"${sectionTitle}"` : 'another question'}`,
        target: 'Decisions',
        isDelete: false,
      }
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

/**
 * idempotency_key -> real database id, accumulated by the caller as it
 * applies create_section actions in a batch, so later actions in the same
 * batch that referenced them via `ref:<idempotency_key>` (see aiProposal.ts's
 * RefOrUuidSchema) can resolve to a real foreign key. Empty/omitted for
 * every call site that only ever applies one action at a time (ingest,
 * auto-apply) — those never carry refs in the first place.
 */
export type RefMap = Map<string, string>

const REF_PREFIX = 'ref:'

/** Resolves a `section_id`/`to_section_id` field that may be a real UUID or a `ref:<idempotency_key>` placeholder. Throws with a reviewer-facing message if the referenced action hasn't been applied yet (or was discarded). */
function resolveRef(value: string, refs: RefMap): string {
  if (!value.startsWith(REF_PREFIX)) return value
  const key = value.slice(REF_PREFIX.length)
  const resolved = refs.get(key)
  if (!resolved) {
    throw new Error('This depends on another proposed change above — approve that one first.')
  }
  return resolved
}

/** Reads a jsonb column value as a plain object for a shallow merge-patch; anything else (null, array, scalar) reads as empty so a patch still applies cleanly. */
function asMergeableObject(value: Json | null | undefined): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

const DELETE_TABLES: Record<string, string> = {
  event: 'trip_timeline_events',
  option: 'options',
  booking: 'bookings',
  expense: 'expenses',
  checklist_item: 'trip_checklists',
}

/**
 * Reference to the row a create_* action produced, so a caller can offer
 * "Undo" (delete this exact row) — used by the AI-autonomy auto-apply
 * toast (UX_REDESIGN.md Part 3 "Ambient AI" #2). Null for action types
 * that don't create a single deletable row (update_event, delete_request).
 */
export interface CreatedEntityRef {
  table: 'trip_timeline_events' | 'bookings' | 'options' | 'expenses' | 'planning_sections'
  id: string
}

/**
 * Apply ONE approved action under the current user's JWT. Throws on
 * failure (RLS denial, FK violation, network) — callers mark the card
 * errored and keep going with the rest of the batch. Returns a reference
 * to the created row (create_* actions only) so callers that need an
 * Undo affordance can delete exactly what was just created, or need to
 * register it in `refs` so a later action in the same batch can resolve a
 * `ref:<idempotency_key>` placeholder pointing at it.
 */
export async function applyAction(action: ProposedAction, ctx: ApplyContext, refs: RefMap = new Map()): Promise<CreatedEntityRef | null> {
  switch (action.type) {
    case 'create_event': {
      const { data, error } = await supabase
        .from('trip_timeline_events')
        .insert({
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
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { table: 'trip_timeline_events', id: data.id }
    }
    case 'create_option': {
      const { data, error } = await supabase
        .from('options')
        .insert({
          section_id: resolveRef(action.section_id, refs),
          title: action.title,
          description: action.description ?? null,
          price: action.price ?? null,
          currency: action.currency ?? null,
          price_type: action.price_type ?? undefined,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { table: 'options', id: data.id }
    }
    case 'create_booking_draft': {
      const { data, error } = await supabase
        .from('bookings')
        .insert({
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
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { table: 'bookings', id: data.id }
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
      return { table: 'expenses', id: expense.id }
    }
    case 'update_event': {
      const update: Record<string, unknown> = {}
      if (action.title !== undefined) update.title = action.title
      if (action.event_date !== undefined) update.event_date = action.event_date
      if (action.start_time !== undefined) update.start_time = action.start_time
      if (action.end_time !== undefined) update.end_time = action.end_time
      if (action.location !== undefined) update.location = action.location
      if (action.description !== undefined) update.description = action.description
      if (Object.keys(update).length === 0) return null
      update.updated_at = new Date().toISOString()
      const { error } = await supabase.from('trip_timeline_events').update(update).eq('id', action.event_id)
      if (error) throw new Error(error.message)
      return null
    }
    case 'update_option': {
      // jsonb metadata MERGE, not replace (UPGRADE_MASTER_PLAN.md §13 build
      // brief): read the current value, spread the patch over it, write the
      // merged object back — a patch that only sets e.g.
      // metadata.pricing.variants must never clobber an existing
      // grid_row/grid_column/price_tiers already on the row.
      let metadata: Json | undefined
      if (action.metadata_patch) {
        const { data: current, error: readError } = await supabase.from('options').select('metadata').eq('id', action.option_id).single()
        if (readError) throw new Error(readError.message)
        metadata = { ...asMergeableObject(current?.metadata as Json | null), ...action.metadata_patch } as unknown as Json
      }
      const update: Record<string, unknown> = {}
      if (action.title !== undefined) update.title = action.title
      if (action.description !== undefined) update.description = action.description
      if (action.price !== undefined) update.price = action.price
      if (action.currency !== undefined) update.currency = action.currency
      if (metadata !== undefined) update.metadata = metadata
      if (Object.keys(update).length === 0) return null
      const { error } = await supabase.from('options').update(update).eq('id', action.option_id)
      if (error) throw new Error(error.message)
      return null
    }
    case 'create_section': {
      const { data, error } = await supabase
        .from('planning_sections')
        .insert({
          trip_id: ctx.tripId,
          title: action.title,
          section_type: action.section_type,
          status: 'in_progress',
          allow_multiple_selections: false,
          order_index: 0,
          voting_method: action.voting_method ?? 'single',
          hide_votes_until_close: true,
          vote_deadline: action.vote_deadline ?? null,
          metadata: { decision_shape: action.decision_shape } as unknown as Json,
        })
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      return { table: 'planning_sections', id: data.id }
    }
    case 'update_section': {
      let metadata: Json | undefined
      if (action.metadata_patch) {
        const { data: current, error: readError } = await supabase.from('planning_sections').select('metadata').eq('id', action.section_id).single()
        if (readError) throw new Error(readError.message)
        metadata = { ...asMergeableObject(current?.metadata as Json | null), ...action.metadata_patch } as unknown as Json
      }
      const update: Record<string, unknown> = {}
      if (action.title !== undefined) update.title = action.title
      if (action.description !== undefined) update.description = action.description
      if (action.vote_deadline !== undefined) update.vote_deadline = action.vote_deadline
      if (metadata !== undefined) update.metadata = metadata
      if (Object.keys(update).length === 0) return null
      const { error } = await supabase.from('planning_sections').update(update).eq('id', action.section_id)
      if (error) throw new Error(error.message)
      return null
    }
    case 'move_option': {
      const { error } = await supabase
        .from('options')
        .update({ section_id: resolveRef(action.to_section_id, refs) })
        .eq('id', action.option_id)
      if (error) throw new Error(error.message)
      return null
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
      return null
    }
  }
}

/** Deletes exactly the row `applyAction` reported creating — the Undo affordance for an auto-applied change. */
export async function undoCreatedEntity(ref: CreatedEntityRef): Promise<void> {
  const { error } = await supabase.from(ref.table).delete().eq('id', ref.id)
  if (error) throw new Error(error.message)
}
