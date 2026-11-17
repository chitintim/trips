import { useCallback, useMemo, useState } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { useTrip, useParticipants, useAllParticipants } from './useTrip'
import { useSections, useVotes, useQuestionPasses } from './usePlanning'
import { useActions } from './useActions'
import { useChecklists } from './useChecklists'
import { useExpenses } from './useExpenses'
import { useClaimResponses, withClaimResponses } from './useClaimResponses'
import { useSettlements, useSettlementCarryovers } from './useSettlements'
import { useTimeline } from './useTimeline'
import { useBookings } from './useBookings'
import { computeBalances, withMoneyParticipants } from '../../features/expenses/lib/balances'
import { fromMinorUnits } from '../money'
import { isTripFinished } from '../answers/answers'
import { computeWaitingOn } from '../todos/computeTodos'
import { todoSurfaceCore } from './todoSurfaces'
import type { Todo, TodoInfo, TripSnapshot, WaitingOn } from '../todos/types'

/**
 * Hooks over the to-dos engine (src/lib/todos/computeTodos.ts).
 *
 * They only read queries the trip screens already own (same query keys, so
 * realtime invalidation in useTripRealtime keeps them fresh) and add NO
 * fetching of their own. Mount them anywhere under a QueryClientProvider.
 */

export interface TripSnapshotResult {
  /** null until EVERY input the engine needs has loaded (never built from partial data). */
  snapshot: TripSnapshot | null
  /** True until the snapshot can be built (any input still loading for the first time). */
  isLoading: boolean
  /** True when an input failed to load, so there will be no snapshot. Treat like loading: show nothing, not 0. */
  isError: boolean
}

type Loaded<T> = { [K in keyof T]: T[K] | undefined | null }

/**
 * All-or-nothing: returns null unless EVERY input the engine needs is present
 * (a snapshot built from partial data would show a wrong count). `balances` is
 * legitimately absent except on Finished trips.
 */
export function assembleSnapshot(inputs: Loaded<Required<Omit<TripSnapshot, 'passes' | 'passesAvailable' | 'balances'>>> & { balances?: TripSnapshot['balances']; passes?: TripSnapshot['passes']; passesAvailable?: boolean }): TripSnapshot | null {
  const { trip, participants, allParticipants, sections, votes, actions, checklists, expenses, settlements, travelEvents, bookings, balances, passes, passesAvailable } = inputs
  if (!trip || !participants || !allParticipants || !sections || !votes || !actions || !checklists || !expenses || !settlements || !travelEvents || !bookings) return null
  return { trip, participants, allParticipants, sections, votes, passes, passesAvailable, actions, checklists, expenses, settlements, balances, travelEvents, bookings }
}

/** Assemble the engine's snapshot from the TanStack cache. */
export function useTripSnapshot(tripId: string | undefined): TripSnapshotResult {
  const trip = useTrip(tripId)
  const participants = useParticipants(tripId)
  const allParticipants = useAllParticipants(tripId)
  const sections = useSections(tripId)
  const votes = useVotes(tripId)
  // Passes ("No preference" / "None for me") count as answered. Fails soft: if the
  // table is not there yet this is [] and never blocks the snapshot; only the
  // first in-flight load does, so a pass can't flash a to-do that is already done.
  const questionPasses = useQuestionPasses(tripId)
  const actions = useActions(tripId)
  const checklists = useChecklists(tripId)
  const expenses = useExpenses(tripId)
  // Replies to receipts sent to the table. Fails soft like the passes: table missing = no `responses`, the old claim rules.
  const claimResponses = useClaimResponses(tripId)
  const settlements = useSettlements(tripId)
  const carryovers = useSettlementCarryovers(tripId)
  const timeline = useTimeline(tripId)
  const bookings = useBookings(tripId)

  const queries = [trip, participants, allParticipants, sections, votes, actions, checklists, expenses, settlements, carryovers, timeline, bookings]
  const isError = queries.some((q) => q.isError && q.data === undefined)

  const tripData = trip.data
  const participantData = participants.data
  const allParticipantData = allParticipants.data
  // The Ideas bucket is ignored by the to-dos engine itself (computeTodos).
  const sectionData = sections.data
  const voteData = votes.data
  const actionData = actions.data
  const checklistData = checklists.data
  const rawExpenseList = expenses.data?.expenses
  const claimRows = claimResponses.rows
  const claimResponsesAvailable = claimResponses.available
  const expenseList = useMemo(
    () => (rawExpenseList ? withClaimResponses(rawExpenseList, claimRows, claimResponsesAvailable) : undefined),
    [rawExpenseList, claimRows, claimResponsesAvailable]
  )
  const settlementList = settlements.data
  const carryoverData = carryovers.data
  const timelineData = timeline.data
  const bookingData = bookings.data

  // Net balances (base-currency major units, negative = owes) are only read on
  // Finished trips, so only pay for the maths there.
  const balances = useMemo(() => {
    if (!tripData || !participantData || !rawExpenseList || !settlementList || !carryoverData) return undefined
    if (!isTripFinished(tripData)) return undefined
    const base = tripData.base_currency
    const ids = withMoneyParticipants(
      participantData.map((p) => p.user_id),
      rawExpenseList,
      settlementList,
      base,
      carryoverData
    )
    const { balances: result } = computeBalances(rawExpenseList, settlementList, ids, base, carryoverData)
    return Object.fromEntries(result.map((b) => [b.userId, fromMinorUnits(b.netBalanceMinor, base)]))
  }, [tripData, participantData, rawExpenseList, settlementList, carryoverData])

  const passesPending = questionPasses.isPending || claimResponses.isPending
  const passList = questionPasses.passes
  const passesAvailable = questionPasses.available
  const snapshot = useMemo<TripSnapshot | null>(
    () =>
      passesPending
        ? null
        : assembleSnapshot({
        trip: tripData,
        participants: participantData,
        allParticipants: allParticipantData,
        sections: sectionData,
        votes: voteData,
        passes: passList,
        passesAvailable,
        actions: actionData,
        checklists: checklistData,
        expenses: expenseList,
        settlements: settlementList,
        balances,
        travelEvents: timelineData,
        bookings: bookingData,
      }),
    [passesPending, passList, passesAvailable, tripData, participantData, allParticipantData, sectionData, voteData, actionData, checklistData, expenseList, settlementList, balances, timelineData, bookingData]
  )

  return { snapshot, isLoading: !snapshot && !isError && !!tripId, isError }
}

export interface UseTodosResult {
  /** Ordered to-dos for the signed-in user (personal group first, then "For you as organiser"). Empty while loading. */
  todos: Todo[]
  /** Informational lines outside the count (e.g. "You'll be able to settle up once..."). */
  info: TodoInfo[]
  /** `todos.length`, or `undefined` while loading / failed: never 0 and never a partial number. */
  count: number | undefined
  /** True if any to-do is overdue (red header pill). False while loading. */
  hasOverdue: boolean
  /** Only show "You're all set ✓" when `!isLoading && count === 0`. */
  isLoading: boolean
  /** An input failed to load; `count` is undefined. */
  isError: boolean
  snapshot: TripSnapshot | null
}

/** The signed-in user's to-dos on one trip. */
export function useTodos(tripId: string | undefined): UseTodosResult {
  const { user } = useAuth()
  const { snapshot, isLoading, isError } = useTripSnapshot(tripId)
  return useMemo(() => {
    if (!snapshot) return { todos: [], info: [], count: undefined, hasOverdue: false, isLoading, isError, snapshot: null }
    const core = todoSurfaceCore(snapshot, user?.id)
    return { ...core, isLoading, isError, snapshot }
  }, [snapshot, user, isLoading, isError])
}

/** Just the count (header pill, dashboard TripCard badge). `count` is `undefined` while loading. */
export function useTodoCount(tripId: string | undefined): { count: number | undefined; hasOverdue: boolean; isLoading: boolean } {
  const { count, hasOverdue: overdue, isLoading } = useTodos(tripId)
  return { count, hasOverdue: overdue, isLoading }
}

export interface UseWaitingOnResult {
  /** null until the snapshot has loaded (never computed from partial data). */
  waitingOn: WaitingOn | null
  isLoading: boolean
  isError: boolean
}

/** The organiser's mirror: who owes what, by person and by item. */
export function useWaitingOn(tripId: string | undefined): UseWaitingOnResult {
  const { snapshot, isLoading, isError } = useTripSnapshot(tripId)
  return useMemo(() => ({ waitingOn: snapshot ? computeWaitingOn(snapshot) : null, isLoading, isError }), [snapshot, isLoading, isError])
}

export interface TodoCountsByTrip {
  /** tripId -> to-do count, for trips whose count has LOADED. A loading trip is absent (not 0). */
  counts: Record<string, number>
  /** Pass to every `<TripCard onAttentionCount={report} />`. Stable identity. `undefined` = still loading. */
  report: (tripId: string, count: number | undefined) => void
  /** Sum across trips, or `undefined` while any reporting trip is still loading. */
  total: number | undefined
  /** True while any trip that has reported is still loading. */
  isLoading: boolean
}

/**
 * Cross-trip count for the dashboard. Each TripCard already mounts
 * `useTodoCount(trip.id)` (no extra fetching: the cards' own queries are the
 * source); this just collects what they report.
 */
export function useTodoCountsByTrip(): TodoCountsByTrip {
  const [reported, setReported] = useState<Record<string, number | undefined>>({})
  const report = useCallback((tripId: string, count: number | undefined) => {
    setReported((prev) => (tripId in prev && prev[tripId] === count ? prev : { ...prev, [tripId]: count }))
  }, [])
  return useMemo(() => ({ ...summariseCounts(reported), report }), [reported, report])
}

/** Fold what the trip cards reported into counts/total/isLoading. A still-loading trip is absent from `counts` and makes `total` undefined. */
export function summariseCounts(reported: Record<string, number | undefined>): Omit<TodoCountsByTrip, 'report'> {
  const counts: Record<string, number> = {}
  let loading = false
  for (const [id, c] of Object.entries(reported)) {
    if (c === undefined) loading = true
    else counts[id] = c
  }
  return { counts, total: loading ? undefined : Object.values(counts).reduce((n, c) => n + c, 0), isLoading: loading }
}
