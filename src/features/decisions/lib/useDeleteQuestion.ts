import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { questionPassesKey } from '../../../lib/queries/usePlanning'

/** What the database removed and kept (the `delete_question` summary). */
export interface DeleteQuestionSummary {
  title: string
  options: number
  votes: number
  selections: number
  passes: number
  todos_deleted: number
  todos_kept: number
  bookings_kept: number
  events_kept: number
  expenses_kept: number
}

export const DELETE_UNAVAILABLE_MESSAGE = 'Deleting questions will be available shortly'

/**
 * True when PostgREST/Postgres says the delete_question function is not there
 * yet (the migration has not been applied): PGRST202 (not in schema cache),
 * 42883 (undefined function), or a message naming the function.
 */
export function isFunctionMissingError(err: unknown, fn = 'delete_question'): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === 'PGRST202' || code === '42883') return true
  const text = typeof message === 'string' ? message : ''
  return text.toLowerCase().includes(fn) && /(could not find|does not exist|schema cache|not found)/i.test(text)
}

/** Fills in zero for any count the function did not return. */
export function toDeleteSummary(raw: unknown): DeleteQuestionSummary {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const n = (key: string) => (typeof r[key] === 'number' ? (r[key] as number) : 0)
  return {
    title: typeof r.title === 'string' ? r.title : '',
    options: n('options'),
    votes: n('votes'),
    selections: n('selections'),
    passes: n('passes'),
    todos_deleted: n('todos_deleted'),
    todos_kept: n('todos_kept'),
    bookings_kept: n('bookings_kept'),
    events_kept: n('events_kept'),
    expenses_kept: n('expenses_kept'),
  }
}

/**
 * The "Book: <option>" to-do that decide_question made for a question, if it is
 * still open. delete_question only removes to-dos with a section_id; the Book:
 * to-do has section_id NULL on purpose and is linked only through the
 * question's `metadata.followup_action_id`, so it would be left behind with
 * nothing to book. Returns its id when it is safe to remove: linked from the
 * question, section_id NULL, title starting "Book:", and not done yet.
 */
export function bookTodoToRemove(
  metadata: unknown,
  action: { id: string; title: string; section_id: string | null; completed_at: string | null } | null
): string | null {
  if (!action || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const followup = (metadata as Record<string, unknown>).followup_action_id
  if (typeof followup !== 'string' || followup !== action.id) return null
  if (action.section_id !== null || action.completed_at !== null) return null
  return action.title.startsWith('Book:') ? action.id : null
}

/** Best-effort: look up the question's open Book: to-do before it is deleted. */
async function findBookTodo(sectionId: string): Promise<string | null> {
  try {
    const { data: section } = await supabase.from('planning_sections').select('metadata').eq('id', sectionId).maybeSingle()
    const meta = section?.metadata
    const followup = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>).followup_action_id : null
    if (typeof followup !== 'string') return null
    const { data: action } = await supabase.from('trip_actions').select('id, title, section_id, completed_at').eq('id', followup).maybeSingle()
    return bookTodoToRemove(meta, action ?? null)
  } catch {
    return null
  }
}

// Remembered for the session: once the function is known to be missing, the
// UI can disable the button instead of letting people hit the error again.
let deleteMissing = false

/**
 * Delete a whole question (organisers) with ONE database call. The function
 * removes the question, its options, everyone's answers and its "answer this
 * question" to-dos in a single transaction, and keeps bookings, timeline
 * events and expenses (their link to the option is cleared).
 */
export function useDeleteQuestion(tripId: string) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (sectionId: string): Promise<DeleteQuestionSummary> => {
      const bookTodoId = await findBookTodo(sectionId)
      const { data, error } = await supabase.rpc('delete_question', { p_section_id: sectionId })
      if (error) {
        if (isFunctionMissingError(error)) {
          deleteMissing = true
          throw new Error(DELETE_UNAVAILABLE_MESSAGE)
        }
        throw new Error(error.message)
      }
      // Only after the question is really gone, so a failed delete never costs the to-do.
      if (bookTodoId) await supabase.from('trip_actions').delete().eq('id', bookTodoId)
      return toDeleteSummary(data)
    },
    onSuccess: () => {
      for (const key of [
        queryKeys.sections(tripId),
        queryKeys.votes(tripId),
        queryKeys.actions(tripId),
        queryKeys.timeline(tripId),
        questionPassesKey(tripId),
      ]) {
        queryClient.invalidateQueries({ queryKey: key })
      }
    },
  })
  // `deleteAvailable` turns false after the first "function missing" failure.
  const deleteAvailable = !(deleteMissing || (mutation.error?.message === DELETE_UNAVAILABLE_MESSAGE))
  return Object.assign(mutation, { deleteAvailable })
}
