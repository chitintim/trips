import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, TablesUpdate } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { assertRowsAffected, throwIfError } from './assertRowsAffected'
import { useAuth } from '../../hooks/useAuth'
import { buildReopenedMetadata } from '../../features/decisions/lib/resolveDecision'
import { invalidateDecisionKeys, isRpcMissingError, toRpcError } from './useDecide'
import type { Json } from '../../types/database.types'

export type Booking = Tables<'bookings'>

export function useBookings(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.bookings(tripId || ''),
    queryFn: async (): Promise<Booking[]> => {
      const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: false })
      throwIfError(error)
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreateBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'bookings'>, 'trip_id'>) => {
      const { data, error } = await supabase
        .from('bookings')
        .insert({ trip_id: tripId, ...input })
        .select()
        .single()
      throwIfError(error)
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export function useUpdateBooking(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TablesUpdate<'bookings'> }) => {
      const { data, error } = await supabase
        .from('bookings')
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to edit this booking, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) }),
  })
}

export interface CancelBookingFollowUps {
  bookingId: string
  /** Delete the linked expense (and unlink it). Omit/false to keep it. */
  removeExpenseId?: string | null
  /** Delete the linked timeline event (and unlink it). Omit/false to keep it. */
  removeEventId?: string | null
}

/**
 * Organiser-chosen follow-ups after a booking is marked cancelled. Nothing
 * is removed unless an id is passed. The target is deleted directly:
 * bookings.expense_id and bookings.timeline_event_id are ON DELETE SET NULL,
 * so the database clears the link itself (the RI action bypasses RLS). That
 * avoids unlinking first and stranding an unlinked booking if the delete is
 * refused. Every step throws on 0 affected rows.
 */
export function useCancelBookingFollowUps(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ removeExpenseId, removeEventId }: CancelBookingFollowUps) => {
      if (removeExpenseId) {
        const { data, error } = await supabase.from('expenses').delete().eq('id', removeExpenseId).select('id')
        throwIfError(error)
        assertRowsAffected(data, "You don't have permission to remove the linked expense (only the payer or an organizer can), or it no longer exists.")
      }
      if (removeEventId) {
        const { data, error } = await supabase.from('trip_timeline_events').delete().eq('id', removeEventId).select('id')
        throwIfError(error)
        assertRowsAffected(data, "You don't have permission to remove the linked event, or it no longer exists.")
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.bookings(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.expenses(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
    },
  })
}

// ---------------------------------------------------------------------------
// Mark booked / unmark booked (migration 20261118090000_decide_and_book.sql)
//
// `mark_booked` sets the legacy options.status = 'booked' flag, optionally
// creates/updates the bookings row linked by option_id, and completes the
// "Book: <option>" to-do made by Decide. `unmark_booked` is the cancel path:
// "Booking cancelled - needs rebooking". Both FAIL SOFT: when the RPC is not in
// the database yet the same writes run client-side (RLS applies).
// ---------------------------------------------------------------------------

/** Booking fields for mark_booked. Only the keys you pass are written when updating. */
export interface MarkBookedBooking {
  title?: string
  vendor?: string | null
  confirmation_ref?: string | null
  amount?: number | string | null
  currency?: string | null
  /** YYYY-MM-DD */
  booking_date?: string | null
  /** ISO timestamp */
  cancellation_deadline?: string | null
  refundable?: boolean
  /** 'reserved' | 'paid' (cancel with unmark_booked). */
  status?: 'reserved' | 'paid'
  document_url?: string | null
  notes?: string | null
  place_id?: string | null
  timeline_event_id?: string | null
  expense_id?: string | null
}

export interface MarkBookedInput {
  optionId: string
  /** Omit to only set the booked flag (no bookings row). */
  booking?: MarkBookedBooking | null
}

export interface MarkBookedResult {
  option_id: string
  section_id: string | null
  booking_id: string | null
  booking_created: boolean
  /** The "Book:" to-do that was completed, if any. */
  action_id: string | null
  source: 'rpc' | 'fallback'
}

export interface UnmarkBookedInput {
  optionId: string
  /** Default true: cancel every live booking linked to the option. */
  cancelBooking?: boolean
  /** Default false: also reopen the question (clears the recorded winner, keeps answers). */
  reopenQuestion?: boolean
}

export interface UnmarkBookedResult {
  option_id: string
  section_id: string | null
  bookings_cancelled: number
  reopened: boolean
  action_id: string | null
  /** True when the question was reopened and its Book: to-do was deleted instead of re-opened. */
  action_removed: boolean
  source: 'rpc' | 'fallback'
}

/** What un-marking an option does to the question's "Book:" to-do: delete it when the question reopens, else re-open it. */
export function unmarkTodoPlan(reopenQuestion: boolean, sectionStatus: string | null): 'delete' | 'reopen' {
  return reopenQuestion && sectionStatus === 'completed' ? 'delete' : 'reopen'
}

function str(r: Record<string, unknown>, k: string): string | null {
  return typeof r[k] === 'string' ? (r[k] as string) : null
}

export function toMarkBookedResult(raw: unknown, source: MarkBookedResult['source']): MarkBookedResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { option_id: str(r, 'option_id') ?? '', section_id: str(r, 'section_id'), booking_id: str(r, 'booking_id'), booking_created: r.booking_created === true, action_id: str(r, 'action_id'), source }
}

export function toUnmarkBookedResult(raw: unknown, source: UnmarkBookedResult['source']): UnmarkBookedResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    option_id: str(r, 'option_id') ?? '',
    section_id: str(r, 'section_id'),
    bookings_cancelled: typeof r.bookings_cancelled === 'number' ? r.bookings_cancelled : 0,
    reopened: r.reopened === true,
    action_id: str(r, 'action_id'),
    action_removed: r.action_removed === true,
    source,
  }
}

async function loadOptionContext(optionId: string) {
  const { data: option, error } = await supabase.from('options').select('id, title, status, currency, place_id, section_id').eq('id', optionId).maybeSingle()
  throwIfError(error)
  if (!option) throw new Error('Option not found')
  const { data: section, error: sErr } = await supabase.from('planning_sections').select('id, trip_id, title, status, metadata').eq('id', option.section_id).maybeSingle()
  throwIfError(sErr)
  if (!section) throw new Error('Question not found')
  return { option, section }
}

function metaObject(m: Json | null | undefined): Record<string, Json | undefined> {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, Json | undefined>) : {}
}

async function logBookingActivity(tripId: string, actor: string, verb: string, optionId: string, label: string, metadata: Record<string, Json | undefined>) {
  try {
    await supabase.from('activity_feed').insert({ trip_id: tripId, actor, verb, entity: { type: 'option', id: optionId, label } as Json, metadata: metadata as Json })
  } catch {
    /* activity never blocks the change */
  }
}

/** Client-side mark_booked, used only when the RPC is missing. */
export async function markBookedFallback(userId: string, input: MarkBookedInput): Promise<MarkBookedResult> {
  const { option, section } = await loadOptionContext(input.optionId)
  const tripId = section.trip_id
  if (option.status === 'cancelled') throw new Error('That option was cancelled, so it cannot be marked booked')
  if (input.booking?.status && input.booking.status !== 'reserved' && input.booking.status !== 'paid') throw new Error('A booking is reserved or paid')

  const { data: flagged, error: fErr } = await supabase.from('options').update({ status: 'booked' }).eq('id', option.id).select('id')
  throwIfError(fErr)
  assertRowsAffected(flagged, "You don't have permission to mark this booked, or it no longer exists.")

  let bookingId: string | null = null
  let created = false
  const b = input.booking
  if (b) {
    const amount = b.amount === '' || b.amount == null ? null : Number(b.amount)
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) throw new Error('The amount is not valid')
    const { data: existing } = await supabase.from('bookings').select('id').eq('option_id', option.id).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1)
    const patch: TablesUpdate<'bookings'> = {}
    const put = <K extends keyof TablesUpdate<'bookings'>>(k: K, v: TablesUpdate<'bookings'>[K]) => {
      if (k in b) patch[k] = v
    }
    put('title', b.title?.trim() || undefined)
    put('vendor', b.vendor?.trim() || null)
    put('confirmation_ref', b.confirmation_ref?.trim() || null)
    put('amount', amount)
    put('currency', b.currency || undefined)
    put('booking_date', b.booking_date || null)
    put('cancellation_deadline', b.cancellation_deadline || null)
    put('refundable', b.refundable)
    put('status', b.status)
    put('document_url', b.document_url?.trim() || null)
    put('notes', b.notes?.trim() || null)
    put('place_id', b.place_id || null)
    put('timeline_event_id', b.timeline_event_id || null)
    put('expense_id', b.expense_id || null)

    if (existing && existing.length > 0) {
      bookingId = existing[0].id
      const { data, error } = await supabase.from('bookings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', bookingId).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to edit this booking, or it no longer exists.")
    } else {
      let eventId = patch.timeline_event_id ?? null
      if (!eventId && !('timeline_event_id' in b)) {
        const { data: ev } = await supabase.from('trip_timeline_events').select('id').eq('source_option_id', option.id).order('created_at').limit(1)
        eventId = ev?.[0]?.id ?? null
      }
      const { data, error } = await supabase
        .from('bookings')
        .insert({ ...patch, title: patch.title ?? option.title, trip_id: tripId, option_id: option.id, booked_by: userId, currency: patch.currency ?? option.currency, timeline_event_id: eventId, place_id: patch.place_id ?? option.place_id })
        .select('id')
        .single()
      throwIfError(error)
      bookingId = data.id
      created = true
    }
  }

  // Complete the Book: to-do (only for the decided option).
  let actionId: string | null = null
  const meta = metaObject(section.metadata)
  const followup = typeof meta.followup_action_id === 'string' ? meta.followup_action_id : null
  if (followup && meta.decided_option_id === option.id) {
    const { data } = await supabase.from('trip_actions').update({ completed_at: new Date().toISOString(), completed_by: userId }).eq('id', followup).is('completed_at', null).select('id, assigned_to')
    if (data && data.length > 0) {
      actionId = data[0].id
      if (!data[0].assigned_to) await supabase.from('trip_action_completions').upsert({ action_id: actionId, user_id: userId, trip_id: tripId }, { onConflict: 'action_id,user_id' })
    }
  }

  await logBookingActivity(tripId, userId, bookingId && !created ? 'booking_updated' : 'booking_added', option.id, option.title, { booking_id: bookingId, booking_created: created, todo_completed: actionId })
  return { option_id: option.id, section_id: section.id, booking_id: bookingId, booking_created: created, action_id: actionId, source: 'fallback' }
}

/** Client-side unmark_booked, used only when the RPC is missing. */
export async function unmarkBookedFallback(userId: string, input: UnmarkBookedInput): Promise<UnmarkBookedResult> {
  const { option, section } = await loadOptionContext(input.optionId)
  const tripId = section.trip_id
  if (option.status === 'booked') {
    const { data, error } = await supabase.from('options').update({ status: 'available' }).eq('id', option.id).select('id')
    throwIfError(error)
    assertRowsAffected(data, "You don't have permission to change this, or it no longer exists.")
  }
  let cancelled = 0
  if (input.cancelBooking !== false) {
    const { data, error } = await supabase.from('bookings').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('option_id', option.id).neq('status', 'cancelled').select('id')
    throwIfError(error)
    cancelled = data?.length ?? 0
  }
  let actionId: string | null = null
  const meta = metaObject(section.metadata)
  const followup = typeof meta.followup_action_id === 'string' ? meta.followup_action_id : null
  let actionRemoved = false
  if (followup && meta.decided_option_id === option.id) {
    if (unmarkTodoPlan(input.reopenQuestion === true, section.status) === 'delete') {
      // The question is open again: the Book: to-do for the old winner means nothing now.
      const { data } = await supabase.from('trip_actions').delete().eq('id', followup).is('section_id', null).select('id')
      actionRemoved = !!data && data.length > 0
    } else {
      const { data } = await supabase.from('trip_actions').update({ completed_at: null, completed_by: null }).eq('id', followup).not('completed_at', 'is', null).select('id')
      if (data && data.length > 0) {
        actionId = data[0].id
        await supabase.from('trip_action_completions').delete().eq('action_id', actionId)
      }
    }
  }
  let reopened = false
  if (input.reopenQuestion && section.status === 'completed') {
    const { data, error } = await supabase.from('planning_sections').update({ status: 'in_progress', metadata: buildReopenedMetadata(section.metadata) }).eq('id', section.id).select('id')
    throwIfError(error)
    assertRowsAffected(data, "You don't have permission to reopen this question, or it no longer exists.")
    reopened = true
  }
  await logBookingActivity(tripId, userId, 'booking_updated', option.id, option.title, { cancelled: true, bookings_cancelled: cancelled, reopened })
  return { option_id: option.id, section_id: section.id, bookings_cancelled: cancelled, reopened, action_id: actionId, action_removed: actionRemoved, source: 'fallback' }
}

/** Mark an option booked (organizers). Optionally records the booking details too. */
export function useMarkBooked(tripId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async (input: MarkBookedInput): Promise<MarkBookedResult> => {
      const { data, error } = await supabase.rpc('mark_booked', { p_option_id: input.optionId, p_booking: (input.booking ?? undefined) as unknown as Json | undefined })
      if (!error) return toMarkBookedResult(data, 'rpc')
      if (isRpcMissingError(error, 'mark_booked')) {
        if (!user) throw new Error('Not signed in')
        return markBookedFallback(user.id, input)
      }
      throw toRpcError(error, 'Could not mark this booked')
    },
    onSuccess: () => invalidateDecisionKeys(queryClient, tripId),
  })
}

/** "Booking cancelled - needs rebooking": clears booked, cancels bookings, re-opens the Book: to-do, optionally reopens the question. */
export function useUnmarkBooked(tripId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async (input: UnmarkBookedInput): Promise<UnmarkBookedResult> => {
      const { data, error } = await supabase.rpc('unmark_booked', {
        p_option_id: input.optionId,
        p_cancel_booking: input.cancelBooking ?? true,
        p_reopen_question: input.reopenQuestion ?? false,
      })
      if (!error) return toUnmarkBookedResult(data, 'rpc')
      if (isRpcMissingError(error, 'unmark_booked')) {
        if (!user) throw new Error('Not signed in')
        return unmarkBookedFallback(user.id, input)
      }
      throw toRpcError(error, 'Could not undo the booking')
    },
    onSuccess: () => invalidateDecisionKeys(queryClient, tripId),
  })
}
