import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Tables, TablesInsert, TablesUpdate } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { useQuestionPasses, useSections, useVotes } from './usePlanning'
import { useParticipants } from './useTrip'
import { withClosedSections, type SectionVoterIds } from '../../features/actions/lib/actionStatus'
import { buildAnsweredSectionVoters } from '../answers/answers'
import { assertRowsAffected, throwIfError } from './assertRowsAffected'
import { callClaimTodo, claimTodoExists } from './claimTodo'

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
      throwIfError(error)
      return (data as ActionWithCompletions[]) || []
    },
    enabled: !!tripId,
  })
}

/**
 * Section-linked actions' derived-completion substrate: section_id -> the
 * set of userIds who've voted in that section. Reuses the trip's already-
 * fetched `useOptions`/`useVotes` caches (same query keys other planning
 * surfaces already populate) rather than issuing a bespoke fetch — see
 * `buildSectionVoters` for the pure join and actionStatus.ts for how it
 * flows into completion.
 */
export function useSectionVoters(tripId: string | undefined): SectionVoterIds {
  const { data: votes } = useVotes(tripId)
  const { data: sections } = useSections(tripId)
  const { data: participants } = useParticipants(tripId)
  // "No preference" / "None for me" count as answered. Fails soft: no table yet = no passes.
  const { passes } = useQuestionPasses(tripId)
  // A closed poll can no longer be voted in, so its linked action counts as
  // done for everyone (see withClosedSections) rather than staying open forever.
  return useMemo(
    () =>
      withClosedSections(
        // Answered = vote OR selection (OR pass, Phase 2): see lib/answers/answers.ts.
        buildAnsweredSectionVoters(sections ?? [], { votes: votes ?? [], passes }),
        sections ?? [],
        (participants ?? []).map((p) => p.user_id)
      ),
    [votes, sections, participants, passes]
  )
}

/**
 * Whether 20261117100000_todo_who_mode.sql is applied (the `who_mode` column, the optional due date and
 * the `claim_todo` RPC). Probed once per session with a zero-row select that errors if the column is
 * missing, plus a harmless RPC call on a made-up id; FAILS SOFT to `false`, which makes the To-dos sheet behave exactly as before the
 * migration (no Anyone for general to-dos, a required deadline, claims only for creator/organizer).
 */
export function useTodoWhoSupport(): boolean {
  const query = useQuery({
    queryKey: ['todoWhoSupport'],
    queryFn: async (): Promise<boolean> => {
      const { error } = await supabase.from('trip_actions').select('who_mode').limit(0)
      if (error) return false
      // Claiming goes through the claim_todo RPC; without it the old front end behaviour is kept.
      return claimTodoExists()
    },
    staleTime: Infinity,
    retry: false,
  })
  return query.data === true
}

export function useCreateAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<TablesInsert<'trip_actions'>, 'trip_id'>): Promise<Tables<'trip_actions'>> => {
      // Returns the created row so callers that link the action elsewhere
      // (e.g. a closed decision stamping followup_action_id into its
      // section metadata) have its id.
      const { data, error } = await supabase
        .from('trip_actions')
        .insert({ trip_id: tripId, ...input })
        .select()
        .single()
      throwIfError(error)
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) }),
  })
}

export function useUpdateAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: TablesUpdate<'trip_actions'> }) => {
      const { data, error } = await supabase.from('trip_actions').update(update).eq('id', id).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to edit this action, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) }),
  })
}

/** Pending-state (non-optimistic) delete. */
export function useDeleteAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.from('trip_actions').delete().eq('id', id).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to delete this action, or it no longer exists.")
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
  /** An Anyone (claimed) to-do: ticked through the claim_todo RPC when it exists. */
  anyone?: boolean
}

/**
 * Toggle an action's completion — optimistic. Individual actions flip
 * `completed_at`/`completed_by` on trip_actions directly; group actions
 * insert/delete the caller's row in trip_action_completions.
 */
export function useToggleActionDone(tripId: string) {
  return useOptimisticMutation<void, ToggleActionDoneVars, ActionWithCompletions[]>({
    mutationFn: async ({ actionId, isGroupAction, userId, done, anyone }) => {
      if (!isGroupAction && anyone) {
        const rpc = await callClaimTodo('action', actionId, done ? 'tick' : 'untick')
        if (!rpc.missing) return
      }
      if (isGroupAction) {
        if (done) {
          const { error } = await supabase
            .from('trip_action_completions')
            .upsert(
              { action_id: actionId, trip_id: tripId, user_id: userId, completed_at: new Date().toISOString() },
              { ignoreDuplicates: true }
            )
          throwIfError(error)
        } else {
          const { error } = await supabase
            .from('trip_action_completions')
            .delete()
            .eq('action_id', actionId)
            .eq('user_id', userId)
          throwIfError(error)
        }
        return
      }

      const { data, error } = await supabase
        .from('trip_actions')
        .update({
          completed_at: done ? new Date().toISOString() : null,
          completed_by: done ? userId : null,
        })
        .eq('id', actionId)
        .select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to update this action, or it no longer exists.")
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

export interface ClaimActionVars {
  id: string
  userId: string
  /** true = "I'll do it"; false = give it back. */
  claim: boolean
}

/**
 * Claim / give back an Anyone to-do. The claim only matches while nobody holds it
 * (`assigned_to IS NULL`), so two people tapping at once resolve on the server: the
 * loser gets a clear message instead of silently stealing it.
 */
export function useClaimAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, userId, claim }: ClaimActionVars) => {
      const rpc = await callClaimTodo('action', id, claim ? 'claim' : 'give_back')
      if (!rpc.missing) return
      // claim_todo is not deployed yet: the pre-migration direct update (creator / organizer only).
      const base = supabase.from('trip_actions')
      const { data, error } = claim
        ? await base.update({ assigned_to: userId }).eq('id', id).is('assigned_to', null).select('id')
        : await base.update({ assigned_to: null, completed_at: null, completed_by: null }).eq('id', id).eq('assigned_to', userId).select('id')
      throwIfError(error)
      assertRowsAffected(
        data,
        claim ? 'Someone else just took this one, or it is no longer up for grabs.' : "You can't give this one back, or it no longer exists."
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) }),
  })
}
