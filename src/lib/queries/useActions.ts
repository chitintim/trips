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
import { callClaimTodo } from './claimTodo'
import type { InvalidatingClient, UndoDescriptor } from './mutationUndo'

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
 * the `claim_todo` RPC). It is applied on live, so this is always true. It used to probe on every open of
 * the trip chat and To-dos sheet (a select plus a `claim_todo` call on a made-up id, which showed up as a
 * failed 400 request each time). If the function were ever missing, the claim mutations still fall back
 * to the pre-migration behaviour.
 */
export function useTodoWhoSupport(): boolean {
  return true
}

/**
 * Create a to-do (trip_actions row) and return the created row. Plain function: the hook below and the trip
 * chat's confirmed "add a to-do" both call it.
 */
export async function createTodo(tripId: string, input: Omit<TablesInsert<'trip_actions'>, 'trip_id'>): Promise<Tables<'trip_actions'>> {
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
}

/** Refresh what a to-do write changes (the to-dos list). Same call the hooks make. */
export function invalidateAfterTodoChange(queryClient: InvalidatingClient, tripId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) })
}

export const invalidateAfterCreateTodo = invalidateAfterTodoChange

export function useCreateAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: Omit<TablesInsert<'trip_actions'>, 'trip_id'>): Promise<Tables<'trip_actions'>> => createTodo(tripId, input),
    onSuccess: () => invalidateAfterCreateTodo(queryClient, tripId),
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
 * Toggle a to-do's completion (trip_actions). Individual actions flip `completed_at`/`completed_by` on
 * trip_actions directly; group actions insert/delete the caller's row in trip_action_completions; an Anyone
 * to-do goes through the claim_todo RPC when it exists. Plain function shared by the hook and the trip chat.
 * Resolves with an undo descriptor (the opposite toggle, self-only).
 */
export async function toggleTodo(
  tripId: string,
  { actionId, isGroupAction, userId, done, anyone }: ToggleActionDoneVars
): Promise<{ undo: UndoDescriptor<'toggleTodo', [string, ToggleActionDoneVars]> }> {
  const undo: UndoDescriptor<'toggleTodo', [string, ToggleActionDoneVars]> = {
    fn: 'toggleTodo',
    args: [tripId, { actionId, isGroupAction, userId, done: !done, anyone }],
    label: done ? 'Untick this to-do' : 'Tick this to-do again',
  }
  if (!isGroupAction && anyone) {
    const rpc = await callClaimTodo('action', actionId, done ? 'tick' : 'untick')
    if (!rpc.missing) return { undo }
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
    return { undo }
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
  return { undo }
}

/**
 * Toggle an action's completion — optimistic. See `toggleTodo` for what is written.
 */
export function useToggleActionDone(tripId: string) {
  return useOptimisticMutation<void, ToggleActionDoneVars, ActionWithCompletions[]>({
    mutationFn: async (vars) => {
      await toggleTodo(tripId, vars)
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
 * Plain function shared by the hook and the trip chat; resolves with an undo descriptor (the opposite claim).
 */
export async function claimTodo(
  { id, userId, claim }: ClaimActionVars
): Promise<{ undo: UndoDescriptor<'claimTodo', [ClaimActionVars]> }> {
  const undo: UndoDescriptor<'claimTodo', [ClaimActionVars]> = {
    fn: 'claimTodo',
    args: [{ id, userId, claim: !claim }],
    label: claim ? 'Give this to-do back' : "Take this to-do again",
  }
  const rpc = await callClaimTodo('action', id, claim ? 'claim' : 'give_back')
  if (!rpc.missing) return { undo }
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
  return { undo }
}

export function useClaimAction(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (vars: ClaimActionVars) => {
      await claimTodo(vars)
    },
    onSettled: () => invalidateAfterTodoChange(queryClient, tripId),
  })
}
