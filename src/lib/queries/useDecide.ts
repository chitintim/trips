import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { useAuth } from '../../hooks/useAuth'
import { queryKeys } from './queryKeys'
import { questionPassesKey } from './usePlanning'
import { buildDecisionMetadata } from '../../features/decisions/lib/closeDecision'
import { getDecisionShape } from '../../features/decisions/lib/decisionShapes'
import type { Json } from '../../types/database.types'

/**
 * Decide a question in ONE step (migration 20261118090000_decide_and_book.sql):
 * close it, stamp the winner, optionally put it on the plan and create the
 * "Book: <option>" to-do, atomically, via the `decide_question` RPC.
 *
 * FAIL-SOFT: if the RPC is not in the database yet (migration not applied) the
 * same steps run client-side in the same order as today's flows
 * (closeDecision + ScheduleItSheet + AddTodoSheet), with a best-effort
 * rollback, so the front end can ship before or after the migration.
 * Result.source says which path ran.
 */

export interface PutOnPlan {
  /** YYYY-MM-DD */
  date: string
  /** HH:MM */
  start_time?: string | null
  end_time?: string | null
  all_day?: boolean
}

export interface BookTodo {
  /** Defaults to the caller. Must be on the trip. */
  assigned_to?: string | null
  due_date?: string | null
  /** Defaults to "Book: <option title>". */
  title?: string
}

export interface DecideInput {
  sectionId: string
  /** Required for a Group choice; omit (null) for an Own choice. */
  optionId?: string | null
  putOnPlan?: PutOnPlan | null
  bookTodo?: BookTodo | null
}

export interface DecideResult {
  section_id: string
  option_id: string | null
  event_id: string | null
  action_id: string | null
  /** The vote was tied at the top (informational; the organizer's pick won regardless). */
  tied: boolean
  /** True when the question was already decided with this winner and nothing was changed. */
  already_decided: boolean
  source: 'rpc' | 'fallback'
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by useBookings.ts)
// ---------------------------------------------------------------------------

/**
 * True when PostgREST/Postgres says the function is not there yet:
 * PGRST202 (not in schema cache), 42883 (undefined function), or a message
 * naming the function. Same rule as useDeleteQuestion.isFunctionMissingError.
 */
export function isRpcMissingError(err: unknown, fn: string): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === 'PGRST202' || code === '42883') return true
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  return text.includes(fn.toLowerCase()) && /(could not find|does not exist|schema cache|not found)/i.test(text)
}

/** A real Error carrying the server's message (supabase-js errors are plain objects). */
export function toRpcError(err: unknown, fallback = 'Something went wrong'): Error {
  if (err instanceof Error) return err
  if (err && typeof err === 'object') {
    const { message, hint, code } = err as { message?: unknown; hint?: unknown; code?: unknown }
    const e = new Error(typeof message === 'string' && message ? message : fallback) as Error & { code?: string; hint?: string }
    if (typeof code === 'string') e.code = code
    if (typeof hint === 'string') e.hint = hint
    return e
  }
  return new Error(fallback)
}

/**
 * Invalidate everything a decision or booking can change: the questions and
 * their answers (to-dos snapshot, Today, Your cost), the plan (timeline,
 * bookings), the to-dos themselves, expenses (cost model), the activity feed.
 */
export function invalidateDecisionKeys(queryClient: QueryClient, tripId: string): void {
  for (const key of [
    queryKeys.sections(tripId),
    queryKeys.options(tripId),
    queryKeys.votes(tripId),
    queryKeys.selections(tripId),
    questionPassesKey(tripId),
    queryKeys.actions(tripId),
    queryKeys.checklists(tripId),
    queryKeys.timeline(tripId),
    queryKeys.bookings(tripId),
    queryKeys.expenses(tripId),
    queryKeys.activityFeed(tripId),
  ]) {
    queryClient.invalidateQueries({ queryKey: key })
  }
}

type Sb = typeof supabase

async function logActivity(
  tripId: string,
  actor: string,
  verb: string,
  entity: Record<string, Json>,
  metadata: Record<string, Json | undefined>
): Promise<void> {
  // Never blocks or fails the primary change.
  try {
    await supabase.from('activity_feed').insert({ trip_id: tripId, actor, verb, entity: entity as Json, metadata: metadata as Json })
  } catch {
    /* ignore */
  }
}

export function bookTitle(optionTitle: string): string {
  return `Book: ${optionTitle}`
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

export function buildDecideRpcArgs(input: DecideInput) {
  return {
    p_section_id: input.sectionId,
    p_option_id: input.optionId ?? undefined,
    p_put_on_plan: (input.putOnPlan ?? undefined) as unknown as Json | undefined,
    p_book_todo: (input.bookTodo ?? undefined) as unknown as Json | undefined,
  }
}

export function toDecideResult(raw: unknown, source: DecideResult['source']): DecideResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null)
  return {
    section_id: s('section_id') ?? '',
    option_id: s('option_id'),
    event_id: s('event_id'),
    action_id: s('action_id'),
    tied: r.tied === true,
    already_decided: r.already_decided === true,
    source,
  }
}

const CATEGORY_BY_SECTION_TYPE: Record<string, string> = {
  accommodation: 'accommodation',
  flights: 'flight',
  transport: 'transport',
  activities: 'activity',
  lessons: 'activity',
}

/** The client-side sequence used when the RPC is missing (see header). Exported for tests. */
export async function decideQuestionFallback(tripId: string, userId: string, input: DecideInput, sb: Sb = supabase): Promise<DecideResult> {
  const { data: section, error: sErr } = await sb.from('planning_sections').select('id, trip_id, title, status, metadata, section_type').eq('id', input.sectionId).maybeSingle()
  if (sErr) throw toRpcError(sErr)
  if (!section) throw new Error('Question not found')
  const own = getDecisionShape(section.metadata) === 'personal'
  const stamp = (section.metadata && typeof section.metadata === 'object' && !Array.isArray(section.metadata) ? (section.metadata as Record<string, Json>).decided_option_id : null) ?? null

  // Same winner asked for again WITH a plan event / Book: to-do: create what is missing, decide nothing new.
  let already = false
  if (section.status === 'completed') {
    if (!own && input.optionId && stamp === input.optionId && (input.putOnPlan || input.bookTodo)) {
      already = true
    } else if ((own && !input.optionId) || (!own && input.optionId && stamp === input.optionId)) {
      return { section_id: section.id, option_id: own ? null : input.optionId!, event_id: null, action_id: null, tied: false, already_decided: true, source: 'fallback' }
    } else {
      throw new Error('This question has already been decided. Reopen it to change the answer.')
    }
  }

  if (own) {
    if (input.optionId || input.putOnPlan || input.bookTodo) throw new Error('An own-choice question has no single winner, so it cannot be put on the plan or booked from here')
    const { data, error } = await sb.from('planning_sections').update({ status: 'completed' }).eq('id', section.id).select('id')
    if (error) throw toRpcError(error)
    if (!data || data.length === 0) throw new Error("You don't have permission to change this question, or it no longer exists.")
    await logActivity(tripId, userId, 'poll_closed', { type: 'section', id: section.id, label: section.title }, { own_choice: true })
    return { section_id: section.id, option_id: null, event_id: null, action_id: null, tied: false, already_decided: false, source: 'fallback' }
  }

  if (!input.optionId) throw new Error('Choose the winning option')
  const { data: option, error: oErr } = await sb.from('options').select('id, title, description, place_id, status, section_id').eq('id', input.optionId).maybeSingle()
  if (oErr) throw toRpcError(oErr)
  if (!option || option.section_id !== section.id || (option.status === 'cancelled' && !already)) throw new Error('That option is not on this question any more')

  let eventId: string | null = null
  let actionId: string | null = null
  const undo = async () => {
    // Best effort: remove what this call created so a failed close leaves nothing half-done.
    if (eventId) await sb.from('trip_timeline_events').delete().eq('id', eventId)
    if (actionId) await sb.from('trip_actions').delete().eq('id', actionId)
  }

  try {
    if (input.putOnPlan) {
      const p = input.putOnPlan
      if (!p.date) throw new Error('Pick a day to put this on the plan')
      const { data: existing } = await sb.from('trip_timeline_events').select('id').eq('source_option_id', option.id).limit(1)
      if (existing && existing.length > 0) {
        eventId = null // reuse: not ours to undo
      } else {
        const { data: ev, error } = await sb
          .from('trip_timeline_events')
          .insert({
            trip_id: tripId,
            created_by: userId,
            title: option.title.slice(0, 200),
            description: option.description,
            category: (CATEGORY_BY_SECTION_TYPE[section.section_type] ?? 'other') as never,
            event_date: p.date,
            all_day: p.all_day ?? !p.start_time,
            start_time: p.start_time || null,
            end_time: p.end_time || null,
            place_id: option.place_id,
            source_option_id: option.id,
          })
          .select('id')
          .single()
        if (error) throw toRpcError(error)
        eventId = ev.id
      }
    }

    const metaObj = section.metadata && typeof section.metadata === 'object' && !Array.isArray(section.metadata) ? (section.metadata as Record<string, Json>) : {}
    const existingFollowup = typeof metaObj.followup_action_id === 'string' ? metaObj.followup_action_id : null
    let followupExists = false
    if (already && existingFollowup) {
      const { data: fa } = await sb.from('trip_actions').select('id').eq('id', existingFollowup).limit(1)
      followupExists = !!fa && fa.length > 0
    }

    if (input.bookTodo && !followupExists) {
      const t = input.bookTodo
      const base = {
        trip_id: tripId,
        title: (t.title?.trim() || bookTitle(option.title)).slice(0, 120),
        notes: `From the question "${section.title}" - decided: ${option.title}.`.slice(0, 400),
        created_by: userId,
        assigned_to: t.assigned_to || userId,
        due_date: t.due_date || null,
      }
      let res = await sb.from('trip_actions').insert({ ...base, deadline_kind: 'fixed' }).select('id').single()
      // An older database still requires a date for fixed deadlines: use "before the trip" instead.
      if (res.error && res.error.code === '23514' && !base.due_date) {
        res = await sb.from('trip_actions').insert({ ...base, deadline_kind: 'before_trip' }).select('id').single()
      }
      if (res.error) throw toRpcError(res.error)
      actionId = res.data.id
    }

    if (already) {
      if (actionId) {
        const { error: mErr } = await sb.from('planning_sections').update({ metadata: buildDecisionMetadata(section.metadata, { followup_action_id: actionId }) }).eq('id', section.id)
        if (mErr) throw toRpcError(mErr)
      }
      return {
        section_id: section.id,
        option_id: option.id,
        event_id: eventId,
        action_id: actionId ?? existingFollowup,
        tied: false,
        already_decided: true,
        source: 'fallback',
      }
    }

    const metadata = buildDecisionMetadata(section.metadata, { decided_option_id: option.id, ...(actionId ? { followup_action_id: actionId } : {}) })
    const { data: closed, error: cErr } = await sb.from('planning_sections').update({ status: 'completed', metadata }).eq('id', section.id).select('id')
    if (cErr) throw toRpcError(cErr)
    if (!closed || closed.length === 0) throw new Error("You don't have permission to decide this question, or it no longer exists.")
  } catch (err) {
    await undo()
    throw err
  }

  await logActivity(tripId, userId, 'poll_closed', { type: 'section', id: section.id, label: section.title }, {
    decided_option_id: option.id,
    decided_option_title: option.title,
    event_id: eventId,
    action_id: actionId,
  })
  return { section_id: section.id, option_id: option.id, event_id: eventId, action_id: actionId, tied: false, already_decided: false, source: 'fallback' }
}

/** Decide a question (organizers). See the file header; resolves with what was created. */
export function useDecideQuestion(tripId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: async (input: DecideInput): Promise<DecideResult> => {
      const { data, error } = await supabase.rpc('decide_question', buildDecideRpcArgs(input))
      if (!error) return toDecideResult(data, 'rpc')
      if (isRpcMissingError(error, 'decide_question')) {
        if (!user) throw new Error('Not signed in')
        return decideQuestionFallback(tripId, user.id, input)
      }
      throw toRpcError(error, 'Could not decide this question')
    },
    onSuccess: () => invalidateDecisionKeys(queryClient, tripId),
  })
}
