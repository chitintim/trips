import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { queryKeys } from './queryKeys'

/**
 * Tables that affect this trip's cached queries, and the query-key branch
 * to invalidate when a postgres_changes event fires for that table. Tables
 * are filtered server-side by `trip_id=eq.${tripId}` where the column
 * exists directly; a few (expense_splits, expense_line_items, etc.) are
 * keyed off their parent's trip_id indirectly and are covered by also
 * subscribing to the parent table's row changes invalidating the same
 * broad `expenses` key (the query fn re-fetches the nested shape anyway).
 */
const TABLE_TO_KEY: Record<string, (tripId: string) => readonly unknown[]> = {
  trips: (id) => queryKeys.tripDetail(id),
  trip_participants: (id) => queryKeys.participants(id),
  planning_sections: (id) => queryKeys.sections(id),
  options: (id) => queryKeys.sections(id),
  selections: (id) => queryKeys.sections(id),
  option_votes: (id) => queryKeys.votes(id),
  comments: (id) => queryKeys.comments(id),
  reactions: (id) => queryKeys.reactions(id),
  expenses: (id) => queryKeys.expenses(id),
  expense_splits: (id) => queryKeys.expenses(id),
  expense_line_items: (id) => queryKeys.expenses(id),
  expense_item_claims: (id) => queryKeys.expenses(id),
  expense_allocation_links: (id) => queryKeys.expenses(id),
  settlements: (id) => queryKeys.settlements(id),
  settlement_carryovers: (id) => queryKeys.settlementCarryovers(id),
  trip_timeline_events: (id) => queryKeys.timeline(id),
  trip_notes: (id) => queryKeys.notes(id),
  bookings: (id) => queryKeys.bookings(id),
  places: (id) => queryKeys.places(id),
  activity_feed: (id) => queryKeys.activityFeed(id),
  ai_proposals: (id) => queryKeys.proposals(id),
  trip_checklists: (id) => queryKeys.checklists(id),
  notifications: (id) => queryKeys.notifications(id),
  trip_chat_messages: (id) => queryKeys.chatMessages(id),
  trip_actions: (id) => queryKeys.actions(id),
  trip_action_completions: (id) => queryKeys.actions(id),
  // users has no trip_id and is embedded (`user:user_id (*)`) into several
  // trip-scoped queries (participants, sections/options, settlements,
  // expenses, notes). Rather than enumerate each of those keys, invalidate
  // the whole `trip(tripId)` prefix -- it cascades to every key nested
  // under it (see queryKeys.ts doc comment). This is a deliberate app-wide
  // fan-out: any user's profile edit (e.g. a new avatar) re-fetches every
  // trip currently open, not just trips that user participates in, since
  // we have no cheap way to filter postgres_changes on `users` by trip
  // membership. Acceptable given how infrequently profiles change.
  users: (id) => queryKeys.trip(id),
}

// Tables filterable directly by trip_id in the postgres_changes subscription.
const DIRECT_TRIP_TABLES = [
  'trips',
  'trip_participants',
  'planning_sections',
  'expenses',
  'settlements',
  'settlement_carryovers',
  'trip_timeline_events',
  'trip_notes',
  'bookings',
  'places',
  'activity_feed',
  'ai_proposals',
  'trip_checklists',
  'notifications',
  'trip_chat_messages',
  'reactions',
  'trip_actions',
  'trip_action_completions',
]

// Tables with no trip_id column — scoped to the trip only via a join
// (option -> section -> trip, or expense -> trip), so we subscribe
// unfiltered and let the debounced flush invalidate the mapped broad key.
// This trip's realtime channel is still trip-scoped by virtue of only
// being mounted while that trip's page is open.
const INDIRECT_TABLES = [
  'options',
  'selections',
  'option_votes',
  'comments',
  'expense_splits',
  'expense_line_items',
  'expense_item_claims',
  'expense_allocation_links',
  // No trip_id column and not trip-scoped at all -- any user's row can be
  // embedded into this trip's cached queries, so we subscribe unfiltered.
  'users',
]

const DEBOUNCE_MS = 200

/**
 * Subscribes to postgres_changes for every table that can affect this
 * trip's cached queries and maps events -> invalidateQueries on the
 * matching query-key branch. Bursts of events (e.g. inserting an expense +
 * N splits) are coalesced into a single invalidation pass per affected key
 * every 200ms, rather than hand-patching the cache from realtime payloads
 * (per UPGRADE_MASTER_PLAN §4 — invalidate, never hand-patch).
 *
 * Mount once per trip (TripDetail).
 */
export function useTripRealtime(tripId: string | undefined) {
  const queryClient = useQueryClient()
  const pendingKeysRef = useRef<Set<string>>(new Set())
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!tripId) return

    const scheduleInvalidate = (table: string) => {
      const keyFn = TABLE_TO_KEY[table]
      if (!keyFn) return
      pendingKeysRef.current.add(table)

      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      flushTimerRef.current = setTimeout(() => {
        const tables = Array.from(pendingKeysRef.current)
        pendingKeysRef.current.clear()
        flushTimerRef.current = null
        for (const t of tables) {
          const fn = TABLE_TO_KEY[t]
          if (fn) queryClient.invalidateQueries({ queryKey: fn(tripId) })
        }
      }, DEBOUNCE_MS)
    }

    const channel = supabase.channel(`trip_realtime:${tripId}`)

    for (const table of DIRECT_TRIP_TABLES) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `trip_id=eq.${tripId}` },
        () => scheduleInvalidate(table)
      )
    }

    for (const table of INDIRECT_TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => scheduleInvalidate(table))
    }

    channel.subscribe()

    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [tripId, queryClient])
}
