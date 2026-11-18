import { buildActionColumns } from '../../actions/lib/todoModel'
import { invalidateAfterCreateTodo } from '../../../lib/queries/useActions'
import type { AddTodoParams } from '../lib/payload'
import type { ActionModule, LiveData } from './types'
import { FINISHED_CARD_MESSAGE, formatDay, isBool, isDay, isNonEmptyStr, isStrOrNull, personActive, personName } from './common'

/**
 * Reminder emails come from the daily auto-chase run (about 09:00 UTC), which reads the to-dos that are still open at that
 * moment: nothing is queued when the to-do is made, a ticked or deleted to-do gets none, and an "anyone" to-do gets none until
 * someone takes it. Stages (actionDueDate.ts): once in the week before the due date, once the day before, once overdue; a to-do
 * made late skips the earlier stages. So the card promises no dates.
 */
export function reminderWords(who: 'me' | 'person' | 'everyone' | 'anyone', whoName: string): string {
  if (who === 'anyone') return 'No reminder email until someone takes it.'
  const subject = who === 'me' ? "you'll get" : who === 'person' ? `${whoName} gets` : 'people who have not done it get'
  return `If it's still open, ${subject} a reminder email in the week before it's due and another once it's overdue.`
}

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as AddTodoParams

function whoLabel(params: AddTodoParams, live: LiveData): { label: string; kind: 'me' | 'person' | 'everyone' | 'anyone'; name: string } {
  if (params.mode === 'everyone') return { label: 'Everyone', kind: 'everyone', name: 'Everyone' }
  if (params.mode === 'anyone') return { label: 'Anyone: the first person to take it', kind: 'anyone', name: 'Anyone' }
  const name = personName(live, params.person_id)
  return { label: name, kind: params.person_id === live.userId ? 'me' : 'person', name }
}

function sectionOf(live: LiveData, id: string | null) {
  return id ? live.sections.find((s) => s.id === id) : undefined
}

export const addTodoModule: ActionModule = {
  validate(x) {
    return (
      isNonEmptyStr(x.title) &&
      isStrOrNull(x.notes) &&
      (x.mode === 'everyone' || x.mode === 'person' || x.mode === 'anyone') &&
      isStrOrNull(x.person_id) &&
      (x.mode !== 'person' || isNonEmptyStr(x.person_id)) &&
      isBool(x.before_trip) &&
      (x.due_date === null || isDay(x.due_date)) &&
      isStrOrNull(x.section_id)
    )
  },

  view(action, live) {
    const params = p(action)
    const who = whoLabel(params, live)
    const q = sectionOf(live, params.section_id)
    const due = params.before_trip ? 'Before the trip' : params.due_date ? formatDay(params.due_date) : 'No date'
    const rows = [
      { label: 'To-do', value: params.title.trim(), quoted: true, field: 'title' },
      { label: 'For', value: who.label },
      { label: 'Due', value: due },
      ...(params.due_date && !params.before_trip ? [{ label: 'Reminders', value: reminderWords(who.kind, who.name) }] : []),
      ...(params.notes?.trim() ? [{ label: 'Notes', value: params.notes.trim(), quoted: true }] : []),
      ...(q ? [{ label: 'About', value: q.title }] : []),
    ]
    return {
      icon: '✅',
      title: 'Add a to-do',
      rows,
      line: `Add to-do "${params.title.trim()}"${who.kind === 'me' ? '' : ` for ${who.label.toLowerCase() === 'everyone' ? 'everyone' : who.name}`}`,
      confirmLabel: 'Add to-do',
      notes: [],
    }
  },

  recheck(action, live) {
    const params = p(action)
    if (live.finished) return FINISHED_CARD_MESSAGE
    if (params.mode === 'anyone' && !live.todoWho) return "'Anyone' to-dos aren't switched on yet, so this can't be added from chat."
    if (!live.todoWho && !params.before_trip && !params.due_date) return 'To-dos need a deadline for now, so this one has to be added from the to-dos screen.'
    if (params.mode === 'person' && params.person_id && !personActive(live, params.person_id)) return `${personName(live, params.person_id)} is no longer on the trip.`
    if (params.section_id) {
      const q = sectionOf(live, params.section_id)
      if (!q) return 'The question this is about is no longer there.'
    }
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    // The same column builder the to-do form uses; nothing here decides what a to-do row looks like.
    const cols = buildActionColumns({
      title: params.title,
      notes: params.notes ?? '',
      mode: params.mode,
      personId: params.person_id ?? '',
      beforeTrip: params.before_trip,
      dueDate: params.due_date ?? '',
      sectionId: params.section_id ?? '',
      bring: false,
    })
    const row = await ctx.deps.createTodo(ctx.tripId, { ...cols, created_by: ctx.userId })
    return { result: { created_id: row.id }, doneText: 'Added to your to-dos.' }
  },

  undoBlocked(action, live) {
    const params = p(action)
    const id = action.result?.created_id
    if (typeof id !== 'string') return 'Nothing to undo.'
    const row = live.actions.find((x) => x.id === id)
    if (!row) return 'That to-do is already gone.'
    // Someone has since ticked, claimed, given or renamed it: it is no longer just what I added.
    if (row.completed_at || (row.trip_action_completions ?? []).length > 0) return 'Someone has ticked that to-do off, so it stays.'
    if (row.title !== params.title.trim()) return 'That to-do has been changed since, so it stays.'
    const expectedAssignee = params.mode === 'person' ? params.person_id : null
    if ((row.assigned_to ?? null) !== (expectedAssignee ?? null)) return 'That to-do has been taken or reassigned since, so it stays.'
    return null
  },

  async undo(action, ctx) {
    const id = action.result?.created_id
    if (typeof id !== 'string') throw new Error('Nothing to undo.')
    await ctx.deps.deleteTodo(ctx.tripId, id)
  },

  invalidate(ctx) {
    void invalidateAfterCreateTodo(ctx.queryClient, ctx.tripId)
  },
}
