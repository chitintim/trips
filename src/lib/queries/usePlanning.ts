import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import {
  PlanningSection,
  PlanningSectionInsert,
  PlanningSectionUpdate,
  Option,
  OptionInsert,
  OptionUpdate,
  Selection,
  User,
} from '../../types'
import { Tables, TablesInsert, Json } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { useTripActivityLog } from '../../features/organizer/lib/activity'

export type OptionVote = Tables<'option_votes'>
export type Reaction = Tables<'reactions'>
export type Comment = Tables<'comments'>

export interface SelectionWithUser extends Selection {
  user: User
}

export interface OptionWithSelections extends Option {
  selections: SelectionWithUser[]
}

export interface SectionWithOptions extends PlanningSection {
  options: OptionWithSelections[]
}

/**
 * Sections + nested options + nested selections, matching PlanningTabV2's
 * fetchPlanningSections select shape exactly (including the sort applied
 * client-side by status then order_index).
 */
export function useSections(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sections(tripId || ''),
    queryFn: async (): Promise<SectionWithOptions[]> => {
      const { data, error } = await supabase
        .from('planning_sections')
        .select(
          `
          *,
          options (
            *,
            selections (
              *,
              user:user_id (*)
            )
          )
        `
        )
        .eq('trip_id', tripId as string)
        .order('order_index', { ascending: true })
        .order('order_index', { referencedTable: 'options', ascending: true })

      if (error) throw error

      const sortedSections = [...((data as unknown as SectionWithOptions[]) || [])].sort((a, b) => {
        const statusOrder: Record<string, number> = { in_progress: 1, not_started: 2, completed: 3 }
        const orderA = statusOrder[a.status] || 4
        const orderB = statusOrder[b.status] || 4
        if (orderA === orderB) return (a.order_index || 0) - (b.order_index || 0)
        return orderA - orderB
      })

      return sortedSections
    },
    enabled: !!tripId,
  })
}

/** Flat options list for a trip (used by places/votes/matrix code that don't need the nested shape). */
export function useOptions(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.options(tripId || ''),
    queryFn: async (): Promise<Option[]> => {
      const { data: sections, error: sectionsErr } = await supabase
        .from('planning_sections')
        .select('id')
        .eq('trip_id', tripId as string)
      if (sectionsErr) throw sectionsErr

      const sectionIds = (sections || []).map((s) => s.id)
      if (sectionIds.length === 0) return []

      const { data, error } = await supabase.from('options').select('*').in('section_id', sectionIds)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

/** Selections for a set of option ids (used for expected_participants lookups, e.g. in expenses). */
export function useSelections(optionIds: string[]) {
  return useQuery({
    queryKey: ['selectionsByOption', optionIds.slice().sort().join(',')] as const,
    queryFn: async (): Promise<Pick<Selection, 'option_id' | 'user_id'>[]> => {
      if (optionIds.length === 0) return []
      const { data, error } = await supabase
        .from('selections')
        .select('option_id, user_id')
        .in('option_id', optionIds)
      if (error) throw error
      return data || []
    },
    enabled: optionIds.length > 0,
  })
}

/** option_votes for every option under this trip (poll voting substrate, separate from selections). */
export function useVotes(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.votes(tripId || ''),
    queryFn: async (): Promise<OptionVote[]> => {
      const { data: sections, error: sectionsErr } = await supabase
        .from('planning_sections')
        .select('id, options(id)')
        .eq('trip_id', tripId as string)
      if (sectionsErr) throw sectionsErr

      const sectionsWithOptions = (sections || []) as unknown as Array<{ id: string; options: { id: string }[] | null }>
      const optionIds = sectionsWithOptions.flatMap((s) => (s.options || []).map((o) => o.id))
      if (optionIds.length === 0) return []

      const { data, error } = await supabase.from('option_votes').select('*').in('option_id', optionIds)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

/** Comments attached to options/sections for a trip. */
export function useComments(tripId: string | undefined, sectionIds: string[]) {
  return useQuery({
    queryKey: queryKeys.comments(tripId || ''),
    queryFn: async (): Promise<Comment[]> => {
      if (sectionIds.length === 0) return []
      const { data, error } = await supabase.from('comments').select('*').in('section_id', sectionIds)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId && sectionIds.length > 0,
  })
}

/** Emoji quick-reactions on options/comments for a trip. */
export function useReactions(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.reactions(tripId || ''),
    queryFn: async (): Promise<Reaction[]> => {
      const { data, error } = await supabase.from('reactions').select('*').eq('trip_id', tripId as string)
      if (error) throw error
      return data || []
    },
    enabled: !!tripId,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateSection(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: Omit<PlanningSectionInsert, 'trip_id'>) => {
      const { data, error } = await supabase
        .from('planning_sections')
        .insert({ ...input, trip_id: tripId })
        .select()
        .single()
      if (error) throw error
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useUpdateSection(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: PlanningSectionUpdate }) => {
      const { error } = await supabase.from('planning_sections').update(update).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useCreateOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: OptionInsert) => {
      const { data, error } = await supabase.from('options').insert(input).select().single()
      if (error) throw error
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useBulkCreateOptions(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (rows: OptionInsert[]) => {
      const { error } = await supabase.from('options').insert(rows)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useUpdateOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: OptionUpdate }) => {
      const { error } = await supabase.from('options').update(update).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useDeleteOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (optionId: string) => {
      const { error } = await supabase.from('options').delete().eq('id', optionId)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

/**
 * Toggle a selection (the *committed choice*, distinct from poll votes).
 * Optimistic: patches the sections cache directly so the UI reflects the
 * add/remove instantly, matching PlanningTabV2's existing handleSelectionUpdate
 * optimistic pattern.
 */
export function useToggleSelection(tripId: string) {
  return useOptimisticMutation<
    void,
    { optionId: string; userId: string; action: 'add' | 'remove'; selectionId?: string; user?: User },
    SectionWithOptions[]
  >({
    mutationFn: async ({ optionId, userId, action, selectionId }) => {
      if (action === 'remove' && selectionId) {
        const { error } = await supabase.from('selections').delete().eq('id', selectionId)
        if (error) throw error
      } else {
        const { error } = await supabase.from('selections').insert({ option_id: optionId, user_id: userId })
        if (error) throw error
      }
    },
    queryKey: () => queryKeys.sections(tripId),
    updater: (sections, { optionId, userId, action, user }) => {
      if (!sections) return sections as unknown as SectionWithOptions[]
      return sections.map((section) => ({
        ...section,
        options: section.options.map((option) => {
          if (option.id !== optionId) return option
          if (action === 'add' && user) {
            return {
              ...option,
              selections: [
                ...option.selections,
                { id: `optimistic-${userId}`, option_id: optionId, user_id: userId, selected_at: new Date().toISOString(), metadata: null, user },
              ],
            }
          }
          return { ...option, selections: option.selections.filter((s) => s.user_id !== userId) }
        }),
      }))
    },
  })
}

/** Vote toggle (poll mechanics, option_votes table) — optimistic. */
export function useToggleVote(tripId: string) {
  const logActivity = useTripActivityLog(tripId)
  return useOptimisticMutation<
    void,
    { optionId: string; userId: string; action: 'add' | 'remove'; voteId?: string; rank?: number | null },
    OptionVote[]
  >({
    mutationFn: async ({ optionId, userId, action, voteId, rank }) => {
      if (action === 'remove' && voteId) {
        const { error } = await supabase.from('option_votes').delete().eq('id', voteId)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('option_votes')
          .upsert({ option_id: optionId, user_id: userId, rank: rank ?? null }, { onConflict: 'option_id,user_id' })
        if (error) throw error
      }
    },
    queryKey: () => queryKeys.votes(tripId),
    updater: (votes, { optionId, userId, action, voteId, rank }) => {
      const list = votes || []
      if (action === 'remove') return list.filter((v) => v.id !== voteId)
      return [
        ...list.filter((v) => !(v.option_id === optionId && v.user_id === userId)),
        { id: `optimistic-${optionId}-${userId}`, option_id: optionId, user_id: userId, rank: rank ?? null, created_at: new Date().toISOString() },
      ]
    },
    options: {
      onSuccess: (_data, vars) => {
        if (vars.action === 'add') {
          logActivity({ verb: 'vote_cast', entity: { type: 'option', id: vars.optionId } })
        }
      },
    },
  })
}

/** Reaction toggle (emoji quick-reactions) — optimistic. */
export function useToggleReaction(tripId: string) {
  return useOptimisticMutation<
    void,
    { targetType: 'option' | 'comment'; targetId: string; userId: string; emoji: string; action: 'add' | 'remove'; reactionId?: string },
    Reaction[]
  >({
    mutationFn: async ({ targetType, targetId, userId, emoji, action, reactionId }) => {
      if (action === 'remove' && reactionId) {
        const { error } = await supabase.from('reactions').delete().eq('id', reactionId)
        if (error) throw error
      } else {
        const row: TablesInsert<'reactions'> = {
          trip_id: tripId,
          user_id: userId,
          emoji,
          option_id: targetType === 'option' ? targetId : null,
          comment_id: targetType === 'comment' ? targetId : null,
        }
        const { error } = await supabase.from('reactions').insert(row)
        if (error) throw error
      }
    },
    queryKey: () => queryKeys.reactions(tripId),
    updater: (reactions, { targetType, targetId, userId, emoji, action, reactionId }) => {
      const list = reactions || []
      if (action === 'remove') return list.filter((r) => r.id !== reactionId)
      return [
        ...list,
        {
          id: `optimistic-${targetId}-${userId}-${emoji}`,
          trip_id: tripId,
          user_id: userId,
          emoji,
          option_id: targetType === 'option' ? targetId : null,
          comment_id: targetType === 'comment' ? targetId : null,
          created_at: new Date().toISOString(),
        },
      ]
    },
  })
}

/**
 * One item's desired end-state in a participant's personal order (shape 2,
 * UX_REDESIGN.md Part 5): `metadata: null` deletes the row (item unchecked),
 * otherwise inserts (no `selectionId`) or updates (existing `selectionId`)
 * the selection's metadata `{start_date, end_date, variant, quantity}`.
 */
export interface OrderItemChange {
  optionId: string
  selectionId: string | null
  metadata: Json | null
}

/**
 * Saves a participant's whole order form in one submit (OrderFormSheet):
 * the caller diffs the catalog against the user's existing selections and
 * passes the resulting insert/update/delete list. Not optimistic — this is
 * an explicit "Save" action, not a live-typing toggle like useToggleSelection.
 */
export function useSaveOrderItems(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, changes }: { userId: string; changes: OrderItemChange[] }) => {
      for (const change of changes) {
        if (change.metadata === null) {
          if (change.selectionId) {
            const { error } = await supabase.from('selections').delete().eq('id', change.selectionId)
            if (error) throw error
          }
          continue
        }
        if (change.selectionId) {
          const { error } = await supabase.from('selections').update({ metadata: change.metadata }).eq('id', change.selectionId)
          if (error) throw error
        } else {
          const { error } = await supabase.from('selections').insert({ option_id: change.optionId, user_id: userId, metadata: change.metadata })
          if (error) throw error
        }
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useCreateComment(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: TablesInsert<'comments'>) => {
      const { error } = await supabase.from('comments').insert(input)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.comments(tripId) }),
  })
}
