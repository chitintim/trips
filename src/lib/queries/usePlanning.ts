import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { useAuth } from '../../hooks/useAuth'
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
import { Tables } from '../../types/database.types'
import { queryKeys } from './queryKeys'
import { useTripActivityLog } from '../../features/organizer/lib/activity'
import { assertRowsAffected, throwIfError } from './assertRowsAffected'
import { useTrip, useParticipants, type ParticipantWithUser } from './useTrip'
import { isTripFinished, type PassKind } from '../answers/answers'
import {
  answerGate,
  applyPlanToPasses,
  applyPlanToSelections,
  applyPlanToVotes,
  orderedSteps,
  planAnswer,
  type AnswerAction,
  type AnswerStep,
  type AnswerGate,
  type AnswerPlan,
  type ModelSection,
  type ModelViewer,
} from '../../features/decisions/lib/answerModel'

export type OptionVote = Tables<'option_votes'>
export type Comment = Tables<'comments'>

export interface SelectionWithUser extends Selection {
  user: User
}

/** An option_votes row with the voting user embedded — who voted for what (audit: RLS already allows this, the frontend just wasn't fetching it). */
export interface OptionVoteWithUser extends OptionVote {
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

      throwIfError(error)

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
      throwIfError(sectionsErr)

      const sectionIds = (sections || []).map((s) => s.id)
      if (sectionIds.length === 0) return []

      const { data, error } = await supabase.from('options').select('*').in('section_id', sectionIds)
      throwIfError(error)
      return data || []
    },
    enabled: !!tripId,
  })
}

/**
 * option_votes for every option under this trip (poll voting substrate,
 * separate from selections), with the voting user embedded so the UI can
 * show WHO voted (option_votes/users RLS already allow reading this for any
 * trip co-participant — see areVotesVisible for the hide-until-close gate
 * that still applies on top).
 */
export function useVotes(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.votes(tripId || ''),
    queryFn: async (): Promise<OptionVoteWithUser[]> => {
      const { data: sections, error: sectionsErr } = await supabase
        .from('planning_sections')
        .select('id, options(id)')
        .eq('trip_id', tripId as string)
      throwIfError(sectionsErr)

      const sectionsWithOptions = (sections || []) as unknown as Array<{ id: string; options: { id: string }[] | null }>
      const optionIds = sectionsWithOptions.flatMap((s) => (s.options || []).map((o) => o.id))
      if (optionIds.length === 0) return []

      const { data, error } = await supabase
        .from('option_votes')
        .select(
          `
          *,
          user:user_id (*)
        `
        )
        .in('option_id', optionIds)
      throwIfError(error)
      return (data as unknown as OptionVoteWithUser[]) || []
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
      throwIfError(error)
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useUpdateSection(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: PlanningSectionUpdate }) => {
      const { data, error } = await supabase.from('planning_sections').update(update).eq('id', id).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to change this question, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useCreateOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: OptionInsert) => {
      const { data, error } = await supabase.from('options').insert(input).select().single()
      throwIfError(error)
      return data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useUpdateOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, update }: { id: string; update: OptionUpdate }) => {
      const { data, error } = await supabase.from('options').update(update).eq('id', id).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to edit this option, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

export function useDeleteOption(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (optionId: string) => {
      const { data, error } = await supabase.from('options').delete().eq('id', optionId).select('id')
      throwIfError(error)
      assertRowsAffected(data, "You don't have permission to delete this option, or it no longer exists.")
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) }),
  })
}

// ---------------------------------------------------------------------------
// Answers: ONE hook to answer any question (proposal 5.4)
// ---------------------------------------------------------------------------

/** A row of `question_passes` ("No preference" / "None for me"). */
export interface QuestionPass {
  section_id: string
  user_id: string
  kind: PassKind
  created_at: string
}

/**
 * Query key for the trip's passes. Nested under ['trip', tripId] so the
 * whole-trip prefix invalidation (users realtime) covers it. NOT subscribed
 * to realtime yet: the table only exists after migration 20261117090000, and
 * subscribing to a missing table can break the shared channel. Once it is
 * applied, add `question_passes: (id) => questionPassesKey(id)` to
 * TABLE_TO_KEY / INDIRECT_TABLES in useTripRealtime.ts.
 */
export const questionPassesKey = (tripId: string) => ['trip', tripId, 'questionPasses'] as const

const NO_PASSES: QuestionPass[] = []

export interface UseQuestionPassesResult {
  /** Always an array: empty while loading and when the table is unavailable. */
  passes: QuestionPass[]
  /**
   * True only once the passes query has SUCCEEDED. Hide the pass button when
   * false: the front end can ship before the migration is applied, and then
   * the query fails (missing table / permission). Everything else keeps
   * working with `passes = []`.
   */
  available: boolean
  /** First load in flight (no data, no error yet). */
  isPending: boolean
  isError: boolean
}

/**
 * Every pass on the trip's questions (so "N of M answered" and the to-dos
 * can count them). FAILS SOFT: a missing table or permission error is
 * treated as "no passes", never thrown to the UI.
 */
export function useQuestionPasses(tripId: string | undefined): UseQuestionPassesResult {
  const query = useQuery({
    queryKey: questionPassesKey(tripId || ''),
    queryFn: async (): Promise<QuestionPass[]> => {
      const { data, error } = await supabase
        .from('question_passes')
        .select('section_id, user_id, kind, created_at, planning_sections!inner(trip_id)')
        .eq('planning_sections.trip_id', tripId as string)
      throwIfError(error)
      return ((data || []) as unknown as Array<QuestionPass>).map((r) => ({
        section_id: r.section_id,
        user_id: r.user_id,
        kind: r.kind,
        created_at: r.created_at,
      }))
    },
    enabled: !!tripId,
    // Do not hammer a table that may not exist yet.
    retry: false,
    staleTime: 15_000,
  })
  return {
    passes: query.data ?? NO_PASSES,
    available: query.isSuccess,
    isPending: !!tripId && query.isPending,
    isError: query.isError,
  }
}

export interface AnswerRequest {
  /** The question (a `SectionWithOptions` from useSections fits as-is). */
  section: ModelSection
  action: AnswerAction
  /**
   * Override who is answering and whether the trip is finished. Normally
   * omitted: the hook reads the trip and participants from the cache.
   */
  viewer?: Pick<ModelViewer, 'tripFinished' | 'out'>
}

export interface AnswerCallbacks {
  onSuccess?: (plan: AnswerPlan) => void
  /** Always a real Error carrying the server message. */
  onError?: (error: Error) => void
  onSettled?: () => void
}

interface AnswerMutationVars {
  plan: AnswerPlan
  /** optionId -> option title, for the activity feed. */
  titles: Record<string, string | undefined>
}

/** The slice of the supabase client the executor needs (injectable for tests). */
export type AnswerWriteClient = Pick<typeof supabase, 'from'>

const CHANGE_FAILED = "Your answer couldn't be changed. It may already have been updated, so please check and try again."
const SAVE_FAILED = "Your answer wasn't saved. Please try again."

async function runAnswerStep(client: AnswerWriteClient, step: AnswerStep): Promise<void> {
  switch (step.type) {
    case 'pass_delete': {
      const { error } = await client.from('question_passes').delete().eq('section_id', step.sectionId).eq('user_id', step.userId)
      throwIfError(error)
      return
    }
    case 'pass_set': {
      const { error } = await client
        .from('question_passes')
        .upsert({ section_id: step.sectionId, user_id: step.userId, kind: step.kind }, { onConflict: 'section_id,user_id', ignoreDuplicates: true })
      throwIfError(error)
      return
    }
    case 'votes_upsert': {
      const rows = step.rows.map((u) => ({ option_id: u.optionId, user_id: step.userId, rank: u.rank }))
      const { data, error } = await client.from('option_votes').upsert(rows, { onConflict: 'option_id,user_id' }).select('id')
      throwIfError(error)
      assertRowsAffected(data, SAVE_FAILED)
      return
    }
    case 'votes_delete_ids': {
      const { data, error } = await client.from('option_votes').delete().in('id', step.ids).eq('user_id', step.userId).select('id')
      throwIfError(error)
      assertRowsAffected(data, CHANGE_FAILED)
      return
    }
    case 'votes_delete_options': {
      const { error } = await client.from('option_votes').delete().in('option_id', step.optionIds).eq('user_id', step.userId)
      throwIfError(error)
      return
    }
    case 'selection': {
      const { change, userId } = step
      // A selection planned while its insert was still in flight carries an
      // optimistic id; by now (writes are serialised) the real row exists, so
      // address it by (option, user) instead.
      const optimistic = !!change.selectionId && change.selectionId.startsWith('optimistic-')
      if (change.metadata === null) {
        if (!change.selectionId) return
        const q = client.from('selections').delete()
        const { data, error } = await (optimistic ? q.eq('option_id', change.optionId).eq('user_id', userId) : q.eq('id', change.selectionId)).select('id')
        throwIfError(error)
        assertRowsAffected(data, CHANGE_FAILED)
      } else if (change.selectionId) {
        const q = client.from('selections').update({ metadata: change.metadata })
        const { data, error } = await (optimistic ? q.eq('option_id', change.optionId).eq('user_id', userId) : q.eq('id', change.selectionId)).select('id')
        throwIfError(error)
        assertRowsAffected(data, CHANGE_FAILED)
      } else {
        const { data, error } = await client.from('selections').insert({ option_id: change.optionId, user_id: userId, metadata: change.metadata }).select('id')
        throwIfError(error)
        assertRowsAffected(data, SAVE_FAILED)
      }
      return
    }
  }
}

/**
 * Run a plan against Supabase, one step at a time, in the order
 * `orderedSteps` gives (see it for the rule: a replacement is always stored
 * BEFORE what it replaces is deleted, and a pass is stored before the answers
 * it supersedes are removed, so a failure part-way never loses an answer).
 * Every call checks the server error (throwIfError) and that rows were really
 * touched (assertRowsAffected) so a blocked write cannot look like success.
 */
export async function executeAnswerPlan(plan: AnswerPlan, client: AnswerWriteClient = supabase): Promise<void> {
  for (const step of orderedSteps(plan)) await runAnswerStep(client, step)
}

export interface UseAnswerResult {
  /**
   * Answer a question. Computes the writes from the CURRENT cache, updates the
   * cache optimistically, writes in order (one at a time per trip), and
   * refetches the server truth when the queue drains (which also undoes the
   * optimistic update after a failure). Never throws; failures
   * arrive in `callbacks.onError` (a real Error with the server message; for a
   * closed question the message is "Voting is closed for this question", which
   * `describeAnswerError` turns into answer wording). Returns false when the
   * action was refused up front (gate closed, nothing to do, pass unavailable).
   */
  answer: (request: AnswerRequest, callbacks?: AnswerCallbacks) => boolean
  /** Same, as a promise: resolves with the plan, rejects with the Error. */
  answerAsync: (request: AnswerRequest) => Promise<AnswerPlan | null>
  /** The gate (can this person answer, and why not) for a question, for callers that only need to know. */
  gateFor: (section: ModelSection, viewer?: Pick<ModelViewer, 'tripFinished' | 'out'>) => AnswerGate
  isPending: boolean
  /** Section currently being written (for per-row spinners). */
  pendingSectionId: string | null
  error: Error | null
}

/**
 * The ONE hook for answering a question, whatever its shape:
 *   - Group choice (single / any / ranked / date options) -> `option_votes`
 *   - Own choice (quantities, variants, dates; legacy grid sections) -> `selections`
 *   - "No preference" / "None for me" -> `question_passes`
 *
 * Replaces useToggleVote / useToggleSelection / useSaveOrderItems at the call
 * sites (those stay exported until every slice has swapped). See
 * `planAnswer` for exactly what each action writes.
 *
 * Invalidates sections, votes, passes and actions after every write, which
 * are all the inputs of the to-dos snapshot (useTodos) and the plan views.
 */
export function useAnswer(tripId: string): UseAnswerResult {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const logActivity = useTripActivityLog(tripId)
  const trip = useTrip(tripId)
  const participants = useParticipants(tripId)

  const mutation = useMutation<AnswerPlan, Error, AnswerMutationVars>({
    mutationKey: ['answer', tripId],
    // Answers for one trip run one at a time, in tap order. TanStack runs
    // `onMutate` at call time (before waiting for the scope queue), and the
    // optimistic update is applied synchronously in `answer()`, so a quick
    // second tap plans against the first tap's result while its WRITES wait
    // for the first to finish. That is what keeps choose-one single.
    scope: { id: `answer:${tripId}` },
    mutationFn: async ({ plan }) => {
      await executeAnswerPlan(plan)
      return plan
    },
    onSuccess: (plan, vars) => {
      if (plan.addedOptionId) {
        logActivity({ verb: 'vote_cast', entity: { type: 'option', id: plan.addedOptionId, label: vars.titles[plan.addedOptionId] } })
      }
    },
    // No snapshot rollback: restoring an old snapshot would wipe the optimistic
    // state of a later, still-queued tap. Instead every settle refetches the
    // server truth, but only once the LAST queued answer has settled (this
    // mutation still counts itself while onSettled runs), so a refetch never
    // overwrites a queued tap's optimistic state with stale rows. After a
    // failure the refetch is what undoes the optimistic update.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: ['answer', tripId] }) > 1) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.votes(tripId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.sections(tripId) })
      void queryClient.invalidateQueries({ queryKey: questionPassesKey(tripId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.actions(tripId) })
    },
  })

  const viewerFor = useCallback(
    (override?: Pick<ModelViewer, 'tripFinished' | 'out'>): ModelViewer => {
      const userId = user?.id ?? null
      const tripData = trip.data
      const me = (participants.data || queryClient.getQueryData<ParticipantWithUser[]>(queryKeys.participants(tripId)))?.find((p) => p.user_id === userId)
      return {
        userId,
        tripFinished: override?.tripFinished ?? (tripData ? isTripFinished(tripData) : false),
        out: override?.out ?? (!!me && (me.active === false || me.confirmation_status === 'declined' || me.confirmation_status === 'cancelled')),
      }
    },
    [user?.id, trip.data, participants.data, queryClient, tripId]
  )

  const gateFor = useCallback<UseAnswerResult['gateFor']>((section, override) => answerGate(section, viewerFor(override)), [viewerFor])

  const answer = useCallback<UseAnswerResult['answer']>(
    (request, callbacks) => {
      const fail = (message: string) => {
        callbacks?.onError?.(new Error(message))
        callbacks?.onSettled?.()
        return false
      }
      const viewer = viewerFor(request.viewer)
      if (!viewer.userId) return fail('Sign in to answer.')
      const gate = answerGate(request.section, viewer)

      const votes = queryClient.getQueryData<OptionVoteWithUser[]>(queryKeys.votes(tripId)) ?? []
      const passesState = queryClient.getQueryState(questionPassesKey(tripId))
      const passes = passesState?.status === 'success' ? queryClient.getQueryData<QuestionPass[]>(questionPassesKey(tripId)) ?? [] : undefined
      // Prefer the freshest sections in the cache (optimistic selections), falling back to the caller's copy.
      const cachedSection = queryClient.getQueryData<SectionWithOptions[]>(queryKeys.sections(tripId))?.find((s) => s.id === request.section.id)
      const section: ModelSection = cachedSection ?? request.section

      const result = planAnswer({ section, userId: viewer.userId, gate, votes, passes }, request.action)
      if (!result.ok) return fail(result.reason)
      const { plan } = result
      if (plan.noop) {
        callbacks?.onSuccess?.(plan)
        callbacks?.onSettled?.()
        return true
      }

      // ---- optimistic update (synchronous so a quick second tap sees it) ----
      const votesKey = queryKeys.votes(tripId)
      const sectionsKey = queryKeys.sections(tripId)
      const passesKey = questionPassesKey(tripId)
      void queryClient.cancelQueries({ queryKey: votesKey })
      void queryClient.cancelQueries({ queryKey: sectionsKey })
      const me = queryClient.getQueryData<ParticipantWithUser[]>(queryKeys.participants(tripId))?.find((p) => p.user_id === viewer.userId)?.user
      const embeddedUser = (me ?? { id: viewer.userId }) as User

      const nowIso = new Date().toISOString()
      if (plan.voteDeletes.length > 0 || plan.voteUpserts.length > 0) {
        queryClient.setQueryData<OptionVoteWithUser[]>(votesKey, (old) =>
          applyPlanToVotes(old ?? [], plan, (u) => ({
            id: `optimistic-${u.optionId}-${plan.userId}`,
            option_id: u.optionId,
            user_id: plan.userId,
            rank: u.rank,
            created_at: nowIso,
            user: embeddedUser,
          }))
        )
      }
      if (plan.selectionChanges.length > 0) {
        queryClient.setQueryData<SectionWithOptions[]>(sectionsKey, (old) =>
          old
            ? applyPlanToSelections(old, plan, (c) => ({
                id: `optimistic-${c.optionId}-${plan.userId}`,
                option_id: c.optionId,
                user_id: plan.userId,
                selected_at: nowIso,
                metadata: c.metadata,
                user: embeddedUser,
              }))
            : old
        )
      }
      if (plan.pass && passes !== undefined) {
        queryClient.setQueryData<QuestionPass[]>(passesKey, (old) =>
          applyPlanToPasses(old ?? [], plan).map((p) => ({ ...p, created_at: (old ?? []).find((o) => o.section_id === p.section_id && o.user_id === p.user_id)?.created_at ?? nowIso }))
        )
      }

      const titles: Record<string, string | undefined> = {}
      for (const o of section.options) titles[o.id] = o.title

      // mutateAsync (not mutate's per-call callbacks, which React Query drops
      // for all but the latest call) so every tap reports back, even in a burst.
      mutation
        .mutateAsync({ plan, titles })
        .then((p) => callbacks?.onSuccess?.(p))
        .catch((e: unknown) => callbacks?.onError?.(e instanceof Error ? e : new Error(String(e))))
        .finally(() => callbacks?.onSettled?.())
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewerFor, queryClient, tripId, mutation.mutateAsync]
  )

  const answerAsync = useCallback<UseAnswerResult['answerAsync']>(
    (request) =>
      new Promise((resolve, reject) => {
        let planned: AnswerPlan | null = null
        const started = answer(request, {
          onSuccess: (p) => {
            planned = p
          },
          onError: reject,
          onSettled: () => resolve(planned),
        })
        // A refusal calls onError (which rejects) first, so nothing more to do.
        void started
      }),
    [answer]
  )

  return {
    answer,
    answerAsync,
    gateFor,
    isPending: mutation.isPending,
    pendingSectionId: mutation.isPending ? mutation.variables?.plan.sectionId ?? null : null,
    error: mutation.error ?? null,
  }
}
