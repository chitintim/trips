import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { isRpcMissingError, toRpcError, invalidateDecisionKeys } from './useDecide'

/**
 * Participant suggestions (migration 20261119090000_suggest_option.sql):
 * `suggest_option` adds ONE safe option to an open question (or an idea to the Ideas
 * question) and `withdraw_suggestion` takes your own back while nobody has answered with it.
 *
 * The migration is applied on live, so the entry is always offered. This used to probe the
 * RPC with an empty title on every trip page load, which showed up as a failed (400) request
 * each time. If the function were ever missing, the mutation below still says so plainly.
 */

export function useSuggestionsAvailable(): boolean {
  return true
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
