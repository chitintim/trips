import { useMemo } from 'react'
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'

export type ChecklistItem = Tables<'trip_checklists'>

/** Lightweight shared checklist ("who's bringing the speaker"). */
export function useChecklists(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.checklists(tripId || ''),
    queryFn: async (): Promise<ChecklistItem[]> => {
      const { data, error } = await supabase
        .from('trip_checklists')
        .select('*')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: true })
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

export function useCreateChecklistItem(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'trip_checklists'>, 'trip_id'>) => {
      const { error } = await supabase.from('trip_checklists').insert({ trip_id: tripId, ...input })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.checklists(tripId) }),
  })
}

export interface ToggleChecklistItemVars {
  id: string
  done: boolean
  doneBy: string | null
}

/** Shared mutationKey prefix so `useChecklistTogglePendingIds` can find in-flight toggles for a trip. */
const TOGGLE_MUTATION_KEY = 'toggleChecklistItem'

/**
 * Check/uncheck a checklist item — optimistic. `doneBy` is the acting
 * user's id (the assignee marking their own item, or an organizer
 * overriding on someone else's behalf); it's only persisted when `done` is
 * true and cleared back to null on un-check, regardless of who un-checks.
 */
export function useToggleChecklistItem(tripId: string) {
  return useOptimisticMutation<void, ToggleChecklistItemVars, ChecklistItem[]>({
    mutationFn: async ({ id, done, doneBy }) => {
      const { error } = await supabase
        .from('trip_checklists')
        .update({ done, done_at: done ? new Date().toISOString() : null, done_by: done ? doneBy : null })
        .eq('id', id)
      if (error) throw error
    },
    queryKey: () => queryKeys.checklists(tripId),
    updater: (items, { id, done, doneBy }) =>
      (items || []).map((item) =>
        item.id === id
          ? { ...item, done, done_at: done ? new Date().toISOString() : null, done_by: done ? doneBy : null }
          : item
      ),
    options: { mutationKey: [TOGGLE_MUTATION_KEY, tripId] },
  })
}

/**
 * Item ids whose toggle mutation is currently in flight for this trip —
 * scoped PER ITEM, not a single global flag. A plain `useMutation()` result
 * only reflects the most recently fired call's `isPending`/`variables`, so
 * if two different items are toggled close together the earlier one's
 * in-flight state would be silently lost; reading react-query's mutation
 * cache directly (filtered by the shared mutationKey + 'pending' status)
 * gives one accurate flag per item instead. Callers disable just the
 * row(s) actually saving, so a rapid double-tap on ONE item can't fire a
 * second mutation for it, while every other row stays fully interactive.
 */
export function useChecklistTogglePendingIds(tripId: string): Set<string> {
  const pendingVariables = useMutationState<ToggleChecklistItemVars>({
    filters: { mutationKey: [TOGGLE_MUTATION_KEY, tripId], status: 'pending' },
    select: (mutation) => mutation.state.variables as ToggleChecklistItemVars,
  })
  return useMemo(() => new Set(pendingVariables.map((v) => v.id)), [pendingVariables])
}

// ---------------------------------------------------------------------------
// Activity-log dedupe: a rapid on/off/on double-tap (fat-finger, or a retry
// on a slow network) must not write a duplicate "ticked off" row into the
// append-only activity_feed for every false->true transition. A DB unique
// constraint isn't right here -- genuinely re-completing an item weeks
// later should log again -- so this is a short client-side coalescing
// window, same shape as src/lib/reportError.ts's dedupe.
// ---------------------------------------------------------------------------

/** Repeating the same item's completion inside this window is dropped. */
const CHECKLIST_COMPLETION_DEDUPE_WINDOW_MS = 30_000

const recentlyLoggedCompletions = new Map<string, number>()

/** Test-only: resets module-level dedupe state between test cases. */
export function __resetChecklistCompletionDedupeStateForTests(): void {
  recentlyLoggedCompletions.clear()
}

/**
 * Pure decision + record: true the first time `itemId` is completed, false
 * for repeats within the window. Exported standalone (rather than inlined
 * at the `logActivity` call site) so the coalescing policy is unit-testable
 * without rendering the component. `tripId` is folded into the key purely
 * as defense-in-depth (trip_checklists ids are already globally-unique
 * UUIDs) so state from different trips can never collide.
 */
export function shouldLogChecklistCompletion(tripId: string, itemId: string, now: number): boolean {
  const key = `${tripId}:${itemId}`
  const last = recentlyLoggedCompletions.get(key)
  if (last !== undefined && now - last < CHECKLIST_COMPLETION_DEDUPE_WINDOW_MS) return false
  recentlyLoggedCompletions.set(key, now)
  return true
}

/** Pending-state (non-optimistic) delete. */
export function useDeleteChecklistItem(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('trip_checklists').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.checklists(tripId) }),
  })
}
