import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { isRpcMissingError, toRpcError, invalidateDecisionKeys } from './useDecide'

/**
 * Participant suggestions (migration 20261119090000_suggest_option.sql):
 * `suggest_option` adds ONE safe option to an open question (or an idea to the Ideas
 * question) and `withdraw_suggestion` takes your own back while nobody has answered with it.
 *
 * FAIL-SOFT: `useSuggestionsAvailable` probes the RPC with an empty title, which the function
 * rejects before it reads or writes anything. Only "function not found" hides the entry; any
 * other answer (including "not allowed") means the migration is there. Before the migration the
 * UI simply offers no suggestion entry.
 */

export function useSuggestionsAvailable(): boolean {
  const query = useQuery({
    queryKey: ['rpc-available', 'suggest_option'],
    queryFn: async (): Promise<boolean> => {
      try {
        const { error } = await supabase.rpc('suggest_option', { p_section_id: null, p_title: '' })
        return !(error && isRpcMissingError(error, 'suggest_option'))
      } catch {
        return false
      }
    },
    retry: false,
    staleTime: 10 * 60_000,
  })
  return query.data === true
}

export interface SuggestInput {
  /** The question to add to. Omit (null) with `idea: true` to add to the trip's Ideas question. */
  sectionId?: string | null
  title: string
  /** Normalized http(s) address, or empty. */
  link?: string
  note?: string
  idea?: boolean
}

export interface SuggestResult {
  option_id: string
  section_id: string
  trip_id: string
  created_section: boolean
}

export function useSuggestOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SuggestInput): Promise<SuggestResult> => {
      const { data, error } = await supabase.rpc('suggest_option', {
        p_section_id: input.sectionId ?? null,
        p_title: input.title.trim(),
        ...(input.link?.trim() ? { p_link: input.link.trim() } : {}),
        ...(input.note?.trim() ? { p_note: input.note.trim() } : {}),
        ...(input.sectionId ? {} : { p_idea: input.idea === true, p_trip_id: tripId }),
      })
      if (error) {
        if (isRpcMissingError(error, 'suggest_option')) throw new Error('Suggestions are not switched on for this trip yet.')
        throw toRpcError(error, 'Could not add your suggestion')
      }
      return data as unknown as SuggestResult
    },
    onSuccess: () => invalidateDecisionKeys(queryClient, tripId),
  })
}

export function useWithdrawSuggestion(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (optionId: string): Promise<{ option_id: string; section_id: string }> => {
      const { data, error } = await supabase.rpc('withdraw_suggestion', { p_option_id: optionId })
      if (error) {
        if (isRpcMissingError(error, 'withdraw_suggestion')) throw new Error('Suggestions are not switched on for this trip yet.')
        throw toRpcError(error, 'Could not withdraw your suggestion')
      }
      return data as unknown as { option_id: string; section_id: string }
    },
    onSuccess: () => invalidateDecisionKeys(queryClient, tripId),
  })
}
