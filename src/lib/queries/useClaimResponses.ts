import { useQuery } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { queryKeys } from './queryKeys'
import { throwIfError } from './assertRowsAffected'
import type { SnapshotExpense } from '../todos/types'

/**
 * `expense_claim_responses` for one trip ("That's everything" = done, "I wasn't there" = not_there), for the to-dos snapshot.
 *
 * The key sits UNDER the trip's expenses key (`['trip', tripId, 'expenses', 'claimResponses']`), so every invalidation of the expenses
 * (a claim saved, a realtime event, the receipt-claim mutations) refreshes it too.
 *
 * `available` is false while the first read is in flight or if it failed: the to-dos engine then keeps the old claim rules (no `responses`
 * on any expense) rather than guessing who has replied.
 */
export const claimResponsesKey = (tripId: string) => [...queryKeys.expenses(tripId), 'claimResponses'] as const

export type ClaimResponseRow = { expense_id: string; user_id: string; response: string }

const NO_ROWS: ClaimResponseRow[] = []

export interface UseClaimResponsesResult {
  rows: ClaimResponseRow[]
  /** The replies were read. */
  available: boolean
  /** First load in flight (the snapshot waits for it so a finished reply cannot flash a to-do). */
  isPending: boolean
}

export function useClaimResponses(tripId: string | undefined): UseClaimResponsesResult {
  const query = useQuery({
    queryKey: claimResponsesKey(tripId || ''),
    queryFn: async (): Promise<ClaimResponseRow[]> => {
      // Typed narrowly by hand: the embedded-join select is not inferred by the generated client types.
      const client = supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => { eq: (c: string, v: string) => Promise<{ data: unknown; error: { message: string } | null }> }
        }
      }
      const { data, error } = await client.from('expense_claim_responses').select('expense_id, user_id, response, expenses!inner(trip_id)').eq('expenses.trip_id', tripId as string)
      throwIfError(error as never)
      return ((data ?? []) as ClaimResponseRow[]).map((r) => ({ expense_id: r.expense_id, user_id: r.user_id, response: r.response }))
    },
    enabled: !!tripId,
    retry: false,
    staleTime: 15_000,
  })
  return { rows: query.data ?? NO_ROWS, available: query.isSuccess, isPending: !!tripId && query.isPending }
}

/**
 * Put each itemised receipt's responses on its snapshot expense. Not read (`available` false): the expenses come back untouched, so the
 * engine sees no `responses` and behaves exactly as before the table existed.
 */
export function withClaimResponses<T extends SnapshotExpense>(expenses: T[], rows: ReadonlyArray<ClaimResponseRow>, available: boolean): T[] {
  if (!available) return expenses
  const byExpense = new Map<string, Array<{ user_id: string; response: string }>>()
  for (const r of rows) {
    const list = byExpense.get(r.expense_id) ?? []
    list.push({ user_id: r.user_id, response: r.response })
    byExpense.set(r.expense_id, list)
  }
  return expenses.map((e) => ({ ...e, responses: byExpense.get(e.id) ?? [] }))
}
