import { emptyQuestion, validateQuestion, type QuestionValues } from '../../plan/lib/addFlow'
import { invalidateAfterCreateQuestion } from '../../plan/lib/useAddToPlanSave'
import type { CreateQuestionParams } from '../lib/payload'
import type { ActionModule, CardRow } from './types'
import { FINISHED_CARD_MESSAGE, formatDeadline, isBool, isNonEmptyStr, isObj, isStrOrNull } from './common'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as CreateQuestionParams

const METHOD_LABEL = { single: 'Choose one', approval: 'Choose any', ranked: 'Rank them' } as const

/** The add-to-plan form values this action stands for: the same object the screen's question form would hold. */
export function questionValuesFor(params: CreateQuestionParams): QuestionValues {
  const v = emptyQuestion(params.currency)
  const prices: Record<string, string> = {}
  for (const o of params.options) if (o.price) prices[o.title.trim().toLowerCase()] = o.price
  return {
    ...v,
    title: params.title.trim(),
    optionsText: params.options.map((o) => o.title.trim()).join('\n'),
    shape: params.shape,
    method: params.method,
    answerBy: params.answer_by ?? '',
    hideResults: params.hide_results,
    sectionType: (['accommodation', 'transport', 'activities'] as const).find((t) => t === params.section_type) ?? 'activities',
    prices,
    basis: params.price_basis,
    currency: params.currency,
  }
}

export const createQuestionModule: ActionModule = {
  validate(x) {
    return (
      isNonEmptyStr(x.title) &&
      (x.shape === 'vote' || x.shape === 'personal') &&
      (x.method === 'single' || x.method === 'approval' || x.method === 'ranked') &&
      isStrOrNull(x.answer_by) &&
      isBool(x.hide_results) &&
      isNonEmptyStr(x.currency) &&
      (x.price_basis === 'each' || x.price_basis === 'total_split') &&
      Array.isArray(x.options) &&
      x.options.length >= 2 &&
      x.options.length <= 20 &&
      x.options.every((o) => isObj(o) && isNonEmptyStr(o.title) && isStrOrNull(o.note) && isStrOrNull(o.price))
    )
  },

  view(action) {
    const params = p(action)
    const rows: CardRow[] = [
      { label: 'Question', value: params.title.trim(), quoted: true, field: 'title' },
      { label: 'Type', value: params.shape === 'personal' ? 'Own choice' : 'Group choice' },
      ...(params.shape === 'vote' ? [{ label: 'Voting', value: METHOD_LABEL[params.method] }] : []),
      ...(params.answer_by ? [{ label: 'Answers close', value: formatDeadline(params.answer_by) }] : []),
      {
        label: 'Options',
        value: `${params.options.length}`,
        lines: params.options.map((o) => `${o.title.trim()}${o.price ? ` · ${params.currency} ${o.price}${params.price_basis === 'total_split' ? ' in total, shared' : ' each'}` : ''}`),
      },
    ]
    const hasNotes = params.options.some((o) => o.note?.trim())
    return {
      icon: '❓',
      title: 'Ask the group a question',
      rows,
      line: `Ask "${params.title.trim()}"`,
      confirmLabel: 'Ask the group',
      notes: hasNotes ? ["Notes on options are not saved when a question is added from chat. You can add them on the question afterwards."] : [],
    }
  },

  recheck(_action, live) {
    if (!live.canManage) return 'Only organizers can ask the group a question.'
    if (live.finished) return FINISHED_CARD_MESSAGE
    return null
  },

  async execute(action, ctx) {
    const v = questionValuesFor(p(action))
    const problem = validateQuestion(v)
    if (problem) throw new Error(problem)
    const { id } = await ctx.deps.createQuestionWithOptions(ctx.tripId, v)
    ctx.logActivity({ verb: 'option_added', entity: { type: 'section', id, label: v.title }, metadata: { via: 'assistant', chat_action_id: action.id } })
    return { result: { section_id: id }, doneText: 'Question added to the plan.' }
  },

  invalidate(ctx) {
    void invalidateAfterCreateQuestion(ctx.queryClient, ctx.tripId)
  },
}
