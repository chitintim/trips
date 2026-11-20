/**
 * Members' own "just me" plans. Only organisers can write `trip_timeline_events` directly (row-level
 * security), so everyone else goes through the `save_my_plan_item` RPC, which only ever touches rows that
 * are theirs alone. Organisers keep their direct writes.
 */
import { supabase } from '../../../lib/supabase'
import type { TimelineEvent, TimelineEventCategory } from '../../../types'

export interface MyPlanItemInput {
  title: string
  /** YYYY-MM-DD */
  date: string
  /** HH:MM or null */
  startTime: string | null
  endTime: string | null
  notes: string | null
  placeId: string | null
  location: string | null
  category: TimelineEventCategory
}

/** Hints the RPC raises with a message written for people. */
const KNOWN_HINTS = new Set([
  'not_participant', 'not_yours', 'bad_item', 'bad_title', 'bad_date', 'bad_time',
  'bad_notes', 'bad_category', 'bad_place', 'bad_location', 'too_many',
])

export const MY_PLAN_ITEM_FALLBACK_MESSAGE = "Couldn't save that. Check your connection and try again."

interface ErrorLike {
  message?: string | null
  hint?: string | null
}

/** The RPC's own message for a known hint; never raw database text. */
export function myPlanItemErrorMessage(err: unknown): string {
  const e = (err && typeof err === 'object' ? err : null) as ErrorLike | null
  const hint = typeof e?.hint === 'string' ? e.hint : ''
  const message = typeof e?.message === 'string' ? e.message.trim() : ''
  if (KNOWN_HINTS.has(hint) && message) return message
  return MY_PLAN_ITEM_FALLBACK_MESSAGE
}

/**
 * True for a plan item the person made for themselves alone: they created it, it is for only them, it did
 * not come from a question's option, and it is not a travel row (travel has its own sheet).
 */
export function isMyPlanItem(
  e: Pick<TimelineEvent, 'created_by' | 'participant_ids' | 'metadata' | 'source_option_id'>,
  userId: string
): boolean {
  if (!userId || e.created_by !== userId) return false
  if (e.source_option_id) return false
  const ids = e.participant_ids
  if (!ids || ids.length !== 1 || ids[0] !== userId) return false
  const meta = e.metadata
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as Record<string, unknown>).travel_details === true) return false
  return true
}

/** The RPC accepts exactly HH:MM; Postgres hands back HH:MM:SS. */
function hhmm(t: string | null | undefined): string | null {
  const m = /^(\d{2}:\d{2})/.exec(t ?? '')
  return m ? m[1] : null
}

function toWire(item: MyPlanItemInput) {
  return {
    title: item.title.trim(),
    date: item.date,
    start_time: hhmm(item.startTime),
    end_time: hhmm(item.endTime),
    notes: item.notes?.trim() || null,
    category: item.category,
    place_id: item.placeId || null,
    location: item.location?.trim() || null,
  }
}

type RpcFn = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>

/**
 * Insert (`id` null), update, or delete (`item` null, `id` required) one of the caller's own plan items.
 * Throws an Error whose message is safe to show. `id` in the result is null after a delete.
 */
export async function saveMyPlanItem(tripId: string, id: string | null, item: MyPlanItemInput | null): Promise<{ id: string | null }> {
  if (item === null && !id) throw new Error(MY_PLAN_ITEM_FALLBACK_MESSAGE)
  // The generated types may not list the function yet.
  const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn
  const { data, error } = await rpc('save_my_plan_item', {
    p_trip_id: tripId,
    p_id: id,
    p_item: item === null ? null : toWire(item),
  })
  if (error) throw new Error(myPlanItemErrorMessage(error))
  const savedId = data && typeof data === 'object' && 'id' in data ? ((data as { id?: unknown }).id as string | null) : null
  return { id: item === null ? null : savedId ?? id }
}
