import { createTodo, toggleTodo, claimTodo } from '../../../lib/queries/useActions'
import { toggleChecklistItem, claimChecklistItem } from '../../../lib/queries/useChecklists'
import { answerQuestion, addOptionToQuestion } from '../../../lib/queries/usePlanning'
import { suggestOption } from '../../../lib/queries/useSuggestions'
import { createExpenseWithSplits } from '../../../lib/queries/useExpenses'
import { createHappening, createQuestionWithOptions } from '../../plan/lib/useAddToPlanSave'
import { setMyTravel } from '../../people/lib/myTravel'
import { saveMyPlanItem } from '../../plan/lib/myPlanItems'
import { supabase } from '../../../lib/supabase'

/**
 * The shared write functions the screens use. The chat calls exactly these (nothing of its own writes trip data),
 * gathered here so tests can swap them for recorders.
 */
export interface ChatDeps {
  createTodo: typeof createTodo
  toggleTodo: typeof toggleTodo
  claimTodo: typeof claimTodo
  toggleChecklistItem: typeof toggleChecklistItem
  claimChecklistItem: typeof claimChecklistItem
  answerQuestion: typeof answerQuestion
  addOptionToQuestion: typeof addOptionToQuestion
  suggestOption: typeof suggestOption
  createExpenseWithSplits: typeof createExpenseWithSplits
  createQuestionWithOptions: typeof createQuestionWithOptions
  setMyTravel: typeof setMyTravel
  saveMyPlanItem: typeof saveMyPlanItem
  createHappening: typeof createHappening
  /** Undo of "add a to-do": remove the row I just created (RLS: creator / organiser). No shared function exists for it yet. */
  deleteTodo: (tripId: string, id: string) => Promise<void>
  /** Undo of "add to the plan for everyone": remove the plan row I just created (RLS: organisers). */
  deleteTimelineEvent: (tripId: string, id: string) => Promise<void>
}

export const defaultDeps: ChatDeps = {
  createTodo,
  toggleTodo,
  claimTodo,
  toggleChecklistItem,
  claimChecklistItem,
  answerQuestion,
  addOptionToQuestion,
  suggestOption,
  createExpenseWithSplits,
  createQuestionWithOptions,
  setMyTravel,
  saveMyPlanItem,
  createHappening,
  async deleteTodo(tripId, id) {
    const { data, error } = await supabase.from('trip_actions').delete().eq('id', id).eq('trip_id', tripId).select('id')
    if (error) throw error
    if (!data || data.length === 0) throw new Error("You can't remove this to-do, or it is already gone.")
  },
  async deleteTimelineEvent(tripId, id) {
    const { data, error } = await supabase.from('trip_timeline_events').delete().eq('id', id).eq('trip_id', tripId).select('id')
    if (error) throw error
    if (!data || data.length === 0) throw new Error("You can't remove this plan item, or it is already gone.")
  },
}
