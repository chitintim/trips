/** propose_add_todo: a to-do for me / a person / everyone / anyone. Executor: createTodo(buildActionColumns(...)). */
import { z } from 'npm:zod@3'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { AddTodoBasis, AddTodoParams, AddTodoPreview } from './cards.ts'
import {
  addDays, baseBasis, dayLabel, daysBetween, gate, isRealDate, line, loadSection, NOT_FOUND_QUESTION, note, onRoster,
  originsFor, parseInput, personRef, storeProposal, tripState, uuid, FINISHED_MESSAGE,
} from './common.ts'

export const TODO_TITLE_MAX = 120
export const TODO_NOTES_MAX = 1000

const Input = z
  .object({
    title: line(TODO_TITLE_MAX),
    notes: note(TODO_NOTES_MAX),
    who: z.enum(['me', 'person', 'everyone', 'anyone']),
    person_id: uuid.nullable(),
    due: z.enum(['none', 'date', 'before_trip']),
    due_date: z.string().nullable(),
    question_id: uuid.nullable(),
  })
  .strict()

export const addTodoSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What needs doing, in a few words (up to 120 characters).' },
    notes: { type: ['string', 'null'], description: 'Optional extra detail.' },
    who: { type: 'string', enum: ['me', 'person', 'everyone', 'anyone'], description: '"me" = the person asking; "person" = one named person (set person_id); "everyone" = each person ticks their own; "anyone" = first to grab it.' },
    person_id: { type: ['string', 'null'], format: 'uuid', description: 'Only with who="person": that person\'s user id from the roster.' },
    due: { type: 'string', enum: ['none', 'date', 'before_trip'] },
    due_date: { type: ['string', 'null'], format: 'date', description: 'YYYY-MM-DD, only with due="date".' },
    question_id: { type: ['string', 'null'], format: 'uuid', description: 'Optional: link the to-do to a question (id from the trip context).' },
  },
  required: ['title', 'notes', 'who', 'person_id', 'due', 'due_date', 'question_id'],
  additionalProperties: false,
}

async function remindersOn(ctx: ToolCtx): Promise<boolean> {
  try {
    const { data, error } = await ctx.client.from('trips').select('chase_settings').eq('id', ctx.tripId).maybeSingle()
    if (error || !data) return true
    const cs = (data as { chase_settings?: { action_reminders?: boolean } | null }).chase_settings
    return cs?.action_reminders !== false
  } catch {
    return true
  }
}

/** When the existing action_due_7d / 1d / overdue emails go out, in words. */
export function reminderWords(due: string, today: string, recipients: string, on: boolean): string {
  if (!on) return 'Reminder emails are switched off for this trip, so no email goes out.'
  const days = daysBetween(today, due)
  const parts: string[] = []
  if (days > 7) parts.push(`about a week before (${dayLabel(addDays(due, -7), today)})`)
  if (days > 1) parts.push(`the day before (${dayLabel(addDays(due, -1), today)})`)
  else parts.push('when it is nearly due')
  parts.push(`if it is still open after ${dayLabel(due, today)}`)
  const last = parts.pop()
  return `${recipients} an email ${parts.join(', ')}${parts.length ? ' and ' : ''}${last}.`
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  // who / person
  let mode: AddTodoParams['mode']
  let personId: string | null = null
  if (v.who === 'person') {
    if (!v.person_id) return refuse('who="person" needs person_id from the roster.')
    personId = v.person_id
    mode = 'person'
  } else {
    if (v.person_id) return refuse('person_id is only for who="person". Use who="me" for the person asking.')
    if (v.who === 'me') {
      personId = ctx.userId
      mode = 'person'
    } else mode = v.who
  }
  if (personId) {
    const p = onRoster(ctx, personId)
    if (!p) return refuse('That person is not on this trip. Use a user id from the roster.')
    if (!p.active || p.confirmationStatus === 'declined' || p.confirmationStatus === 'cancelled') {
      return refuse(`${p.name} is not going on this trip, so a to-do cannot be given to them.`)
    }
  }

  // due
  let beforeTrip = false
  let dueDate: string | null = null
  if (v.due === 'date') {
    if (!v.due_date || !isRealDate(v.due_date)) return refuse('due="date" needs due_date as a real YYYY-MM-DD date.')
    if (v.due_date < ctx.today) return refuse(`That date (${v.due_date}) has already passed. Today is ${ctx.today}.`)
    dueDate = v.due_date
  } else {
    if (v.due_date) return refuse('due_date is only for due="date".')
    if (v.due === 'before_trip') {
      if (ctx.trip.start_date.slice(0, 10) < ctx.today) return refuse('The trip has already started, so "before the trip" has passed. Pick a date.')
      beforeTrip = true
    }
  }

  // linked question
  let sectionTitle: string | null = null
  let sectionStatus: string | null = null
  let sectionUpdated: string | null = null
  if (v.question_id) {
    const s = await loadSection(ctx, v.question_id)
    if (!s) return refuse(NOT_FOUND_QUESTION)
    if (s.status === 'completed') return refuse('That question is already decided, so a to-do linked to it is no longer needed.')
    sectionTitle = s.title
    sectionStatus = s.status
    sectionUpdated = s.updated_at
  }

  const params: AddTodoParams = {
    title: v.title,
    notes: v.notes,
    mode,
    person_id: personId,
    before_trip: beforeTrip,
    due_date: dueDate,
    section_id: v.question_id,
  }

  const who = personId ? personRef(ctx, personId) : null
  const whoLabel = mode === 'everyone' ? 'Everyone' : mode === 'anyone' ? 'Anyone — first to grab it' : personId === ctx.userId ? 'You' : who!.name
  const effectiveDue = beforeTrip ? ctx.trip.start_date.slice(0, 10) : dueDate
  const recipients = mode === 'person' ? (personId === ctx.userId ? "You'll get" : `${who!.name} gets`) : mode === 'everyone' ? 'Everyone who has not done it yet gets' : 'People who have not done it yet get'
  const on = effectiveDue ? await remindersOn(ctx) : true
  const preview: AddTodoPreview = {
    title: v.title,
    notes: v.notes,
    mode,
    who_label: whoLabel,
    who,
    due_label: beforeTrip ? `Before the trip (${dayLabel(effectiveDue!, ctx.today)})` : dueDate ? dayLabel(dueDate, ctx.today) : null,
    reminder_words: effectiveDue ? reminderWords(effectiveDue, ctx.today, recipients, on) : null,
    question_title: sectionTitle,
    content_origin: await originsFor(ctx, [{ field: 'title', text: v.title, sources: ['todo', 'option'] }]),
  }
  const basis: AddTodoBasis = {
    ...baseBasis(ctx, state),
    assignee_active: personId ? true : null,
    section_status: sectionStatus,
    section_updated_at: sectionUpdated,
  }
  // Tap only for a to-do for me; anything touching other people is reviewed.
  const requires = mode === 'person' && personId === ctx.userId ? 'tap' : 'review'
  return storeProposal(ctx, { kind: 'add_todo', params, preview, basis, requires })
}

export const proposeAddTodo: ToolModule = {
  name: 'propose_add_todo',
  description:
    'Suggest adding a to-do (for the person asking, a named person, everyone, or anyone). Nothing is added until the person taps Confirm on the card. "Remind me to X on Friday" = a to-do for me due that date (the app sends its normal reminder emails).',
  statusLabel: 'Preparing a to-do…',
  inputSchema: addTodoSchema,
  run,
}
