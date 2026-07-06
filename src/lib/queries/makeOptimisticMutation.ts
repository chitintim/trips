import { QueryClient, QueryKey, useMutation, useQueryClient, UseMutationOptions } from '@tanstack/react-query'

/**
 * Optimistic mutation factory implementing the standard TanStack Query
 * cancel -> snapshot -> setQueryData -> rollback-on-error -> invalidate-on-settled
 * dance, so individual hooks don't have to hand-roll it.
 *
 * Usage:
 *   const toggleVote = useOptimisticMutation({
 *     mutationFn: (vars) => supabase.from('option_votes')...,
 *     queryKey: (vars) => queryKeys.votes(tripId),
 *     updater: (old, vars) => ...next cache value...,
 *   })
 *
 * `queryKey` may return a single key or an array of keys — every affected
 * query gets cancelled/snapshotted/rolled back/invalidated together (e.g. a
 * vote toggle might need to patch both the votes list and a derived
 * needs-attention query).
 *
 * Deletes should NOT use this helper — the brief calls for pending-state
 * (non-optimistic) UX for destructive actions; just use a plain
 * useMutation with an invalidate onSuccess for those.
 */

type KeyOrKeys = QueryKey | QueryKey[]

function toKeyArray(k: KeyOrKeys): QueryKey[] {
  if (k.length === 0) return [k as QueryKey]
  // A QueryKey is itself an array; disambiguate "array of keys" vs "a key"
  // by checking if the first element is itself an array/tuple.
  return Array.isArray(k[0]) ? (k as QueryKey[]) : [k as QueryKey]
}

export interface OptimisticMutationConfig<TData, TVars, TCacheValue = unknown> {
  mutationFn: (vars: TVars) => Promise<TData>
  /** Query key(s) whose cache should be optimistically patched. */
  queryKey: (vars: TVars) => KeyOrKeys
  /** Given the previous cached value and the mutation variables, return the optimistic next value. */
  updater: (previous: TCacheValue | undefined, vars: TVars) => TCacheValue
  /** Extra react-query mutation options (onSuccess, onError side-effects, etc.) merged in. */
  options?: Omit<
    UseMutationOptions<TData, unknown, TVars, { previous: Array<[QueryKey, unknown]> }>,
    'mutationFn' | 'onMutate' | 'onError' | 'onSettled'
  >
}

export function makeOptimisticMutation<TData, TVars, TCacheValue = unknown>(
  queryClient: QueryClient,
  config: OptimisticMutationConfig<TData, TVars, TCacheValue>
) {
  const { mutationFn, queryKey, updater, options } = config

  return {
    mutationFn,
    onMutate: async (vars: TVars) => {
      const keys = toKeyArray(queryKey(vars))

      await Promise.all(keys.map((k) => queryClient.cancelQueries({ queryKey: k })))

      const previous: Array<[QueryKey, unknown]> = keys.map((k) => [k, queryClient.getQueryData(k)])

      keys.forEach((k) => {
        queryClient.setQueryData(k, (old: TCacheValue | undefined) => updater(old, vars))
      })

      return { previous }
    },
    onError: (_err: unknown, _vars: TVars, context: { previous: Array<[QueryKey, unknown]> } | undefined) => {
      context?.previous.forEach(([k, value]) => {
        queryClient.setQueryData(k, value)
      })
    },
    onSettled: (_data: TData | undefined, _err: unknown, vars: TVars) => {
      const keys = toKeyArray(queryKey(vars))
      keys.forEach((k) => queryClient.invalidateQueries({ queryKey: k }))
    },
    ...options,
  }
}

/**
 * Convenience hook wrapper: builds the QueryClient-bound optimistic mutation
 * config and returns `useMutation(config)` directly.
 */
export function useOptimisticMutation<TData, TVars, TCacheValue = unknown>(
  config: OptimisticMutationConfig<TData, TVars, TCacheValue>
) {
  const queryClient = useQueryClient()
  return useMutation(makeOptimisticMutation(queryClient, config))
}
