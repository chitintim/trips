import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, TablesUpdate } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'

export type ActionCompletion = Pick<Tables<'trip_action_completions'>, 'user_id' | 'completed_at'>

/** A trip_actions row with its embedded per-user completion rows (group actions). */
export type ActionWithCompletions = Tables<'trip_actions'> & {
  trip_action_completions: ActionCompletion[]
}

/** Shared travel actions/to-dos ("book flights", "get visa") — individual or whole-group. */
export function useActions(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.actions(tripId || ''),
    queryFn: async (): Promise<ActionWithCompletions[]> => {
      const { data, error } = await supabase
        .from('trip_actions')
        .select('*, trip_action_completions(user_id, completed_at)')
        .eq('trip_id', tripId as string)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data as ActionWithCompletions[]) || []
    },
    enabled: !!tripId,
  })
}

export function useCreateAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'trip_actions'>, 'trip_id'>) => {
      const { error } = await supabase.from('trip_actions').insert({ trip_id: tripId, ...input })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) }),
  })
}

export function useUpdateAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TablesUpdate<'trip_actions'> }) => {
      const { error } = await supabase.from('trip_actions').update(update).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) }),
  })
}

/** Pending-state (non-optimistic) delete. */
export function useDeleteAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('trip_actions').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) }),
  })
}

export interface ToggleActionDoneVars {
  /** The action being toggled. */
  actionId: string
  /** Whether the action is individual (assigned_to set) or whole-group. */
  isGroupAction: boolean
  /** Caller's user id — recorded as completed_by / the completion row owner. */
  userId: string
  /** Target completion state: true to mark done, false to clear. */
  done: boolean
}

/**
 * Toggle an action's completion — optimistic. Individual actions flip
 * `completed_at`/`completed_by` on trip_actions directly; group actions
 * insert/delete the caller's row in trip_action_completions.
 */
export function useToggleActionDone(tripId: string) {
  return useOptimisticMutation<void, ToggleActionDoneVars, ActionWithCompletions[]>({
    mutationFn: async ({ actionId, isGroupAction, userId, done }) => {
      if (isGroupAction) {
        if (done) {
          const { error } = await supabase
            .from('trip_action_completions')
            .upsert(
              { action_id: actionId, trip_id: tripId, user_id: userId, completed_at: new Date().toISOString() },
              { ignoreDuplicates: true }
            )
          if (error) throw error
        } else {
          const { error } = await supabase
            .from('trip_action_completions')
            .delete()
            .eq('action_id', actionId)
            .eq('user_id', userId)
          if (error) throw error
        }
        return
      }

      const { error } = await supabase
        .from('trip_actions')
        .update({
          completed_at: done ? new Date().toISOString() : null,
          completed_by: done ? userId : null,
        })
        .eq('id', actionId)
      if (error) throw error
    },
    queryKey: () => queryKeys.actions(tripId),
    updater: (actions, { actionId, isGroupAction, userId, done }) =>
      (actions || []).map((action) => {
        if (action.id !== actionId) return action

        if (isGroupAction) {
          const completions = action.trip_action_completions || []
          const nextCompletions = done
            ? completions.some((c) => c.user_id === userId)
              ? completions
              : [...completions, { user_id: userId, completed_at: new Date().toISOString() }]
            : completions.filter((c) => c.user_id !== userId)
          return { ...action, trip_action_completions: nextCompletions }
        }

        return {
          ...action,
          completed_at: done ? new Date().toISOString() : null,
          completed_by: done ? userId : null,
        }
      }),
  })
}
