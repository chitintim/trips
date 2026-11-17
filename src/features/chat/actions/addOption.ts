import { emptyQuestion, buildQuestionOptionRows } from '../../plan/lib/addFlow'
import { invalidateAfterAddOption } from '../../../lib/queries/usePlanning'
import type { AddOptionParams } from '../lib/payload'
import type { ActionModule } from './types'
import { FINISHED_CARD_MESSAGE, isNonEmptyStr, isStrOrNull } from './common'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as AddOptionParams

export const addOptionModule: ActionModule = {
  validate(x) {
    return (
      isNonEmptyStr(x.section_id) &&
      (x.shape === 'vote' || x.shape === 'personal') &&
      isNonEmptyStr(x.title) &&
      isStrOrNull(x.note) &&
      isStrOrNull(x.price) &&
      isStrOrNull(x.currency) &&
      (x.price_basis === null || x.price_basis === 'each' || x.price_basis === 'total_split')
    )
  },

  view(action, live) {
    const params = p(action)
    const q = live.sections.find((s) => s.id === params.section_id)
    return {
      icon: '➕',
      title: 'Add an option',
      rows: [
        { label: 'Question', value: q?.title ?? 'a question' },
        { label: 'Option', value: params.title.trim(), quoted: true, field: 'title' },
        ...(params.note?.trim() ? [{ label: 'Note', value: params.note.trim(), quoted: true }] : []),
        ...(params.price ? [{ label: 'Price', value: `${params.currency ?? ''} ${params.price}${params.price_basis === 'total_split' ? ' in total, shared' : ' each'}`.trim() }] : []),
      ],
      line: `Add option "${params.title.trim()}" to "${q?.title ?? 'a question'}"`,
      confirmLabel: 'Add option',
      notes: [],
    }
  },

  recheck(action, live) {
    const params = p(action)
    if (!live.canManage) return 'Only organizers can add options to a question.'
    if (live.finished) return FINISHED_CARD_MESSAGE
    const q = live.sections.find((s) => s.id === params.section_id)
    if (!q) return 'That question is no longer there.'
    if (q.status === 'completed') return 'That question has been decided, so it is closed.'
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    const q = ctx.live().sections.find((s) => s.id === params.section_id)
    if (!q) throw new Error('That question is no longer there.')
    // The same row builder the question form uses (price, basis, currency), then this option's place in the list and its note.
    const v = {
      ...emptyQuestion(params.currency ?? ctx.live().baseCurrency),
      shape: params.shape,
      optionsText: params.title.trim(),
      prices: params.price ? { [params.title.trim().toLowerCase()]: params.price } : {},
      basis: params.price_basis ?? 'each',
    }
    const [row] = buildQuestionOptionRows(v, params.section_id)
    const created = await ctx.deps.addOptionToQuestion({ ...row, order_index: q.options.length, description: params.note?.trim() || null })
    ctx.logActivity({ verb: 'option_added', entity: { type: 'option', id: created.id, label: created.title }, metadata: { via: 'assistant', chat_action_id: action.id } })
    return { result: { option_id: created.id }, doneText: 'Option added.' }
  },

  invalidate(ctx) {
    void invalidateAfterAddOption(ctx.queryClient, ctx.tripId)
  },
}
