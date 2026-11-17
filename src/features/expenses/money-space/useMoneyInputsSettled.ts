import { useIsFetching } from '@tanstack/react-query'

const MONEY_INPUT_KEYS = new Set(['expenses', 'settlements', 'settlementCarryovers', 'detail'])

/**
 * True when none of the queries the Money position is computed from (expenses with their claims, settlements, carryovers, the trip's
 * freeze state) is loading or refetching. `explainMoneyPosition` only claims "balances changed since they were frozen" from inputs
 * that are all of the same generation: right after a freeze the trip row, the settlements and the expenses arrive one by one, and any
 * two of them can disagree for a moment.
 */
export function useMoneyInputsSettled(tripId: string | undefined): boolean {
  const fetching = useIsFetching({
    predicate: (q) => {
      const key = q.queryKey
      return !!tripId && key[0] === 'trip' && key[1] === tripId && typeof key[2] === 'string' && MONEY_INPUT_KEYS.has(key[2])
    },
  })
  return fetching === 0
}
