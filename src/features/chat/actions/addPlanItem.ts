import { queryKeys } from '../../../lib/queries/queryKeys'
import { buildMyPlanItemInput, emptyHappening } from '../../plan/lib/addFlow'
import { myPlanItemErrorMessage } from '../../plan/lib/myPlanItems'
import type { AddPlanItemParams } from '../lib/payload'
import type { ActionModule } from './types'
import { FINISHED_CARD_MESSAGE, formatDay, isDay, isNonEmptyStr, isStrOrNull } from './common'

export const GROUP_PLAN_ORGANISERS_ONLY = 'Only organisers can add to the group plan.'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as AddPlanItemParams

function label(preview: Record<string, unknown>, key: string): string | null {
  const v = preview[key]
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : null
}

/** "19:00–21:00", or "19:00 → 02:00 next day" when the end is earlier than the start. */
function timeWords(params: AddPlanItemParams): string {
  if (!params.start_time) return ''
  if (!params.end_time) return ` ${params.start_time}`
  return params.end_time < params.start_time ? ` ${params.start_time} → ${params.end_time} next day` : ` ${params.start_time}–${params.end_time}`
}

/** The same values the Add form holds for a plain happening, so the same builders decide what is saved. */
function happeningValues(params: AddPlanItemParams, currency: string) {
  return {
    ...emptyHappening(params.date, currency),
    title: params.title,
    hasTime: !!params.start_time,
    startTime: params.start_time ?? '',
    endTime: params.start_time ? (params.end_time ?? '') : '',
    notes: params.notes ?? '',
  }
}

export const addPlanItemModule: ActionModule = {
  validate(x) {
    return (
      isNonEmptyStr(x.title) &&
      isDay(x.date) &&
      isStrOrNull(x.start_time) &&
      isStrOrNull(x.end_time) &&
      (x.for === 'me' || x.for === 'everyone') &&
      isStrOrNull(x.notes)
    )
  },

  view(action) {
    const params = p(action)
    const pv = action.preview
    const when = label(pv, 'when_label') ?? `${formatDay(params.date)}${timeWords(params)}`
    const forLabel = params.for === 'everyone' ? 'Everyone' : 'Just you'
    const note = pv.date_check === true ? label(pv, 'date_note') : null
    return {
      icon: '📅',
      title: 'Add to the plan',
      rows: [
        { label: 'What', value: params.title.trim(), quoted: true, field: 'title' },
        { label: 'When', value: when },
        { label: 'For', value: forLabel },
        ...(params.notes?.trim() ? [{ label: 'Notes', value: params.notes.trim(), quoted: true }] : []),
      ],
      line: `Add "${params.title.trim()}" to the plan, ${when}${params.for === 'everyone' ? ' for everyone' : ''}`,
      confirmLabel: 'Add to plan',
      notes: [],
      ...(note ? { warnings: [note] } : {}),
    }
  },

  recheck(action, live) {
    const params = p(action)
    if (live.finished) return FINISHED_CARD_MESSAGE
    if (params.for === 'everyone' && !live.canManage) return GROUP_PLAN_ORGANISERS_ONLY
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    const live = ctx.live()
    const values = happeningValues(params, live.baseCurrency)
    if (params.for === 'me') {
      const saved = await ctx.deps.saveMyPlanItem(ctx.tripId, null, buildMyPlanItemInput(values))
      if (!saved.id) throw new Error("Couldn't save that. Check your connection and try again.")
      return { result: { created_id: saved.id, for: 'me' }, doneText: 'Added to the plan.' }
    }
    if (!live.canManage) throw new Error(GROUP_PLAN_ORGANISERS_ONLY)
    let created
    try {
      created = await ctx.deps.createHappening(ctx.tripId, ctx.userId, values)
    } catch (err) {
      throw new Error(myPlanItemErrorMessage(err)) // never the database's own words
    }
    // The Add sheet logs this for organisers' group items; the just-me RPC logs nothing.
    ctx.logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: params.title.trim() }, metadata: { via: 'assistant', chat_action_id: action.id } })
    return { result: { created_id: created.id, for: 'everyone' }, doneText: 'Added to the plan.' }
  },

  undoBlocked(action, live) {
    const params = p(action)
    const id = action.result?.created_id
    if (typeof id !== 'string') return 'Nothing to undo.'
    if (!live.events) return "Couldn't check the plan just now."
    const row = live.events.find((e) => e.id === id)
    if (!row) return 'That plan item is already gone.'
    if (row.title !== params.title.trim() || String(row.event_date).slice(0, 10) !== params.date) return 'That plan item has been changed since, so it stays.'
    return null
  },

  async undo(action, ctx) {
    const id = action.result?.created_id
    if (typeof id !== 'string') throw new Error('Nothing to undo.')
    if (action.result?.for === 'everyone') {
      await ctx.deps.deleteTimelineEvent(ctx.tripId, id)
      return
    }
    await ctx.deps.saveMyPlanItem(ctx.tripId, id, null)
  },

  invalidate(ctx) {
    void ctx.queryClient.invalidateQueries({ queryKey: queryKeys.timeline(ctx.tripId) })
  },
}
