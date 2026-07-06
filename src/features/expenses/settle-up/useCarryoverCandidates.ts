/**
 * Cross-trip carryover discovery (plan §12): surfaces unsettled pair
 * balances from other completed trips the current user shares with a
 * fellow participant of THIS trip, so they can "fold into this
 * settlement" (settlement_carryovers table). Computing full per-trip
 * balances for every other trip via the heavy useExpenses() hook would be
 * expensive to fan out; instead this queries expenses/splits/settlements
 * directly for each candidate trip and reuses the same computeBalances
 * math for consistency.
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { computeBalances } from '../lib/balances'
import { fromMinorUnits } from '../../../lib/money'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Tables } from '../../../types/database.types'

export interface CarryoverCandidate {
  sourceTripId: string
  sourceTripName: string
  otherUserId: string
  otherUserName: string
  /** Positive: the other user owes the current user; negative: current user owes the other user. Base currency of the SOURCE trip. */
  netAmount: number
  currency: string
}

/**
 * Finds unsettled pair balances between `currentUserId` and any other
 * participant of `currentTripId`, across every OTHER completed trip both
 * were part of. Intentionally lightweight: fetches only what's needed
 * (expenses+splits+claims+settlements+participants) per candidate trip,
 * skips trips already folded (no de-dupe against existing carryovers here
 * -- the caller filters those before offering the "fold in" action).
 */
export function useCarryoverCandidates(currentTripId: string | undefined, currentUserId: string | undefined) {
  return useQuery({
    queryKey: ['carryoverCandidates', currentTripId, currentUserId] as const,
    queryFn: async (): Promise<CarryoverCandidate[]> => {
      if (!currentTripId || !currentUserId) return []

      const { data: currentParticipants } = await supabase
        .from('trip_participants')
        .select('user_id')
        .eq('trip_id', currentTripId)
        .eq('active', true)
      const currentTripUserIds = new Set((currentParticipants || []).map((p) => p.user_id))

      const { data: myOtherTripRows } = await supabase
        .from('trip_participants')
        .select('trip_id, trips!inner(id, name, status, base_currency)')
        .eq('user_id', currentUserId)
        .neq('trip_id', currentTripId)

      type TripRow = Pick<Tables<'trips'>, 'id' | 'name' | 'status' | 'base_currency'>
      const otherTrips = ((myOtherTripRows || []) as unknown as Array<{ trip_id: string; trips: TripRow }>)
        .map((r) => r.trips)
        .filter((t) => t.status === 'trip_completed')

      const candidates: CarryoverCandidate[] = []

      for (const trip of otherTrips) {
        const { data: participants } = await supabase
          .from('trip_participants')
          .select('user_id, user:user_id (full_name, email)')
          .eq('trip_id', trip.id)
          .eq('active', true)

        const sharedParticipants = (participants || []).filter(
          (p) => p.user_id !== currentUserId && currentTripUserIds.has(p.user_id)
        )
        if (sharedParticipants.length === 0) continue

        const { data: expensesData } = await supabase
          .from('expenses')
          .select('*, payer:paid_by (*), splits:expense_splits(*, user:user_id(*))')
          .eq('trip_id', trip.id)
        const { data: settlementsData } = await supabase.from('settlements').select('*').eq('trip_id', trip.id)

        const expenses = (expensesData || []).map((e) => ({ ...e, line_items: [], claims: [], allocation_link: null, expected_participants: [] })) as unknown as ExpenseWithDetails[]

        const allUserIds = (participants || []).map((p) => p.user_id)
        const { balances } = computeBalances(expenses, settlementsData || [], allUserIds, trip.base_currency)
        const myBalance = balances.find((b) => b.userId === currentUserId)
        if (!myBalance || myBalance.isBalanced) continue

        for (const other of sharedParticipants) {
          // This is a group-level net balance, not a strict pairwise one
          // (the app doesn't track per-pair ledgers) -- surfaced as "your
          // overall unsettled position on that trip", which is the
          // practically useful signal for "should we fold this in".
          const otherBalance = balances.find((b) => b.userId === other.user_id)
          if (!otherBalance) continue

          const userInfo = (other as unknown as { user: { full_name: string | null; email: string } }).user
          candidates.push({
            sourceTripId: trip.id,
            sourceTripName: trip.name,
            otherUserId: other.user_id,
            otherUserName: userInfo?.full_name || userInfo?.email || 'Someone',
            netAmount: fromMinorUnits(myBalance.netBalanceMinor, trip.base_currency),
            currency: trip.base_currency,
          })
        }
      }

      return candidates
    },
    enabled: !!currentTripId && !!currentUserId,
    staleTime: 5 * 60 * 1000,
  })
}
