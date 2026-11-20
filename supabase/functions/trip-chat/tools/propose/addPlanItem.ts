/** propose_add_plan_item: a happening on the plan, just for the person asking or (organisers) for everyone. */
import { z } from 'npm:zod@3'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { AddPlanItemBasis, AddPlanItemParams, AddPlanItemPreview } from './cards.ts'
import { baseBasis, FINISHED_MESSAGE, gate, line, note, originsFor, parseInput, storeProposal, tripState } from './common.ts'
import { BAD_DATE_MESSAGE, BAD_TIME_MESSAGE, dateFlags, dateLooksRight, isTime, passedMessage, whenLabel } from './tripDates.ts'

export const PLAN_TITLE_MAX = 120
export const PLAN_NOTES_MAX = 500
export const EVERYONE_REFUSED = 'Only organisers can add to the group plan. I can add it just for this person, or suggest it as an idea.'

const Input = z
  .object({
    title: line(PLAN_TITLE_MAX),
    date: z.string(),
    start_time: z.string().nullable(),
    end_time: z.string().nullable(),
    for: z.enum(['everyone', 'me']),
    notes: note(PLAN_NOTES_MAX),
  })
  .strict()

export const addPlanItemSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What is happening, in a few words (up to 120 characters), e.g. "Dinner in Tokyo".' },
    date: { type: 'string', format: 'date', description: 'YYYY-MM-DD.' },
    start_time: { type: ['string', 'null'], description: 'HH:MM (24-hour) or null for an all-day item.' },
    end_time: { type: ['string', 'null'], description: 'HH:MM or null. An end before the start means it runs into the next day.' },
    for: { type: 'string', enum: ['me', 'everyone'], description: '"me" = only the person asking (the default); "everyone" = the group plan, organisers only.' },
    notes: { type: ['string', 'null'], description: 'Optional extra detail (up to 500 characters).' },
  },
  required: ['title', 'date', 'start_time', 'end_time', 'for', 'notes'],
  additionalProperties: false,
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  if (v.for === 'everyone' && !ctx.me.canManageTrip) return refuse(EVERYONE_REFUSED)
  if (!dateLooksRight(ctx, v.date)) return refuse(BAD_DATE_MESSAGE)
  if (v.date < ctx.today) return refuse(passedMessage(v.date))
  for (const [label, t] of [['start_time', v.start_time], ['end_time', v.end_time]] as const) {
    if (t != null && !isTime(t)) return refuse(`${label}: ${BAD_TIME_MESSAGE}`)
  }
  if (v.end_time && !v.start_time) return refuse('end_time needs start_time. Give both, or leave both empty.')

  const params: AddPlanItemParams = {
    title: v.title,
    date: v.date,
    start_time: v.start_time,
    end_time: v.end_time,
    for: v.for,
    notes: v.notes,
  }
  // An end before the start runs into the next day.
  const timePart = v.start_time
    ? v.end_time ? (v.end_time < v.start_time ? `${v.start_time} → ${v.end_time} next day` : `${v.start_time}–${v.end_time}`) : v.start_time
    : null
  const preview: AddPlanItemPreview = {
    title: v.title,
    notes: v.notes,
    when_label: whenLabel(ctx, v.date, timePart),
    for_label: v.for === 'me' ? 'Just you' : 'Everyone',
    ...dateFlags(ctx, v.date),
    content_origin: await originsFor(ctx, [{ field: 'title', text: v.title, sources: ['option'] }]),
  }
  const basis: AddPlanItemBasis = { ...baseBasis(ctx, state), can_manage_trip: ctx.me.canManageTrip }
  return storeProposal(ctx, { kind: 'add_plan_item', params, preview, basis, requires: v.for === 'me' ? 'tap' : 'review' })
}

export const proposeAddPlanItem: ToolModule = {
  name: 'propose_add_plan_item',
  description:
    'Suggest adding something that is happening to the plan (a dinner, a night somewhere, an activity): by default just for the person asking (for "me"). Organisers may add it for everyone; anyone else only for themselves. Dates a few days before or after the trip are normal. Nothing is added until the person approves the card.',
  statusLabel: 'Preparing a plan item…',
  inputSchema: addPlanItemSchema,
  run,
}
