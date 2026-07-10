/**
 * Cross-trip carryover discovery (plan §12): surfaces unsettled PAIRWISE
 * balances from other completed trips the current user shares with a
 * fellow participant of THIS trip, so they can "fold into this
 * settlement" (settlement_carryovers table). Computing full per-trip
 * balances for every other trip via the heavy useExpenses() hook would be
 * expensive to fan out; instead this queries expenses/splits/claims/
 * settlements directly for each candidate trip and reuses
 * computePairwiseBreakdown (the SAME pairwise math the Money position
 * header uses) for consistency.
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { computePairwiseBreakdown } from '../money-space/moneyPosition'
import { BALANCE_EPSILON_MINOR } from '../lib/balances'
import { computeRemainingCarryoverMinor } from './carryoverDedupe'
import { fromMinorUnits } from '../../../lib/money'
import type { ExpenseWithDetails, ExpenseLineItem, ExpenseItemClaim } from '../../../lib/queries/useExpenses'
import type { Tables } from '../../../types/database.types'
import type { User } from '../../../types'

export interface CarryoverCandidate {
  sourceTripId: string
  sourceTripName: string
  otherUserId: string
  otherUserName: string
  /** Positive: the other user owes the current user; negative: current user owes the other user. Base currency of the SOURCE trip. Already net of any carryovers previously folded for this exact (source trip, pair) combination. */
  netAmount: number
  currency: string
}

type ClaimWithUser = ExpenseItemClaim & { user: Pick<User, 'id' | 'full_name' | 'avatar_data'> }

const emptyResult = <T,>() => Promise.resolve({ data: [] as T[], error: null as null })

/**
 * Finds unsettled TRUE PAIRWISE balances between `currentUserId` and any
 * other participant of `currentTripId`, across every OTHER completed trip
 * both were part of. Intentionally lightweight: fetches only what's needed
 * (expenses+splits+line_items+claims+settlements+existing carryovers) per
 * candidate trip.
 *
 * Two correctness fixes vs. the original version of this hook:
 *  1. Uses computePairwiseBreakdown (current user vs. THAT specific other
 *     participant) instead of broadcasting the current user's GROUP-level
 *     net balance on the source trip to every shared participant -- which
 *     let the same money be offered (and folded) against multiple people.
 *  2. Fetches real expense_line_items/expense_item_claims for the source
 *     trip's itemized expenses (mirroring useExpenses' assembly), instead
 *     of stubbing them to [] -- itemized expenses have no expense_splits
 *     rows (see ExpenseEditorWizard.tsx), so the stubbed version credited
 *     the payer without ever debiting a claimant.
 *
 * De-dupe: subtracts amounts already folded for the exact same (source
 * trip, currentUser, other participant) pair -- across ANY target trip, not
 * just this one, since the same source-trip debt must not be foldable into
 * two different trips' settlements. A pair fully folded (remaining amount
 * within BALANCE_EPSILON_MINOR of zero) is excluded entirely. The fold-in
 * UI (SettleUpTab's handleFoldInCarryover) always folds the full remaining
 * amount in one action -- there's no partial-amount input -- so "already
 * folded" in practice means "fully folded," but the running-subtraction
 * approach still degrades correctly if that ever changes.
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

        const rawExpenses = (expensesData || []) as unknown as ExpenseWithDetails[]
        const itemizedExpenseIds = rawExpenses.filter((e) => e.ai_parsed && e.status).map((e) => e.id)

        const [settlementsRes, existingCarryoversRes, lineItemsRes, claimsRes] = await Promise.all([
          supabase.from('settlements').select('*').eq('trip_id', trip.id),
          // De-dupe source: every carryover row already folded FROM this
          // source trip, regardless of which trip it was folded INTO --
          // folding the same old debt into two different trips would double
          // count it. (RLS only returns rows whose target trip the current
          // user can still view -- see useCarryoverCandidates report notes.)
          supabase.from('settlement_carryovers').select('*').eq('source_trip_id', trip.id),
          itemizedExpenseIds.length > 0
            ? supabase.from('expense_line_items').select('*').in('expense_id', itemizedExpenseIds).order('line_number')
            : emptyResult<ExpenseLineItem>(),
          itemizedExpenseIds.length > 0
            ? supabase.from('expense_item_claims').select('*, user:user_id (id, full_name, avatar_data)').in('expense_id', itemizedExpenseIds)
            : emptyResult<ClaimWithUser>(),
        ])

        const lineItemsByExpense = new Map<string, ExpenseLineItem[]>()
        for (const item of lineItemsRes.data || []) {
          const list = lineItemsByExpense.get(item.expense_id) || []
          list.push(item)
          lineItemsByExpense.set(item.expense_id, list)
        }

        const claimsByExpense = new Map<string, ClaimWithUser[]>()
        for (const claim of (claimsRes.data || []) as ClaimWithUser[]) {
          const list = claimsByExpense.get(claim.expense_id) || []
          list.push(claim)
          claimsByExpense.set(claim.expense_id, list)
        }

        const expenses: ExpenseWithDetails[] = rawExpenses.map((expense) => ({
          ...expense,
          line_items: lineItemsByExpense.get(expense.id) || [],
          claims: claimsByExpense.get(expense.id) || [],
          allocation_link: null,
          expected_participants: [],
        }))

        const allUserIds = (participants || []).map((p) => p.user_id)
        const pairwise = computePairwiseBreakdown(expenses, settlementsRes.data || [], allUserIds, currentUserId, trip.base_currency)
        const existingCarryovers = existingCarryoversRes.data || []

        for (const other of sharedParticipants) {
          const row = pairwise.find((r) => r.userId === other.user_id)
          if (!row) continue // balanced (or no shared expense history) between exactly these two on this trip

          const remainingMinor = computeRemainingCarryoverMinor(row.netMinor, existingCarryovers, currentUserId, other.user_id)
          if (Math.abs(remainingMinor) < BALANCE_EPSILON_MINOR) continue // fully folded already -- don't re-offer

          const userInfo = (other as unknown as { user: { full_name: string | null; email: string } }).user
          candidates.push({
            sourceTripId: trip.id,
            sourceTripName: trip.name,
            otherUserId: other.user_id,
            otherUserName: userInfo?.full_name || userInfo?.email || 'Someone',
            netAmount: fromMinorUnits(remainingMinor, trip.base_currency),
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
