import { invalidateAfterSuggestOption } from '../../../lib/queries/useSuggestions'
import type { SuggestOptionParams } from '../lib/payload'
import type { ActionModule } from './types'
import { FINISHED_CARD_MESSAGE, isBool, isNonEmptyStr, isStrOrNull } from './common'
import { safeHref } from '../lib/safeHref'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as SuggestOptionParams

export const suggestOptionModule: ActionModule = {
  validate(x) {
    return (x.section_id === null || isNonEmptyStr(x.section_id)) && isBool(x.idea) && isNonEmptyStr(x.title) && isStrOrNull(x.note) && isStrOrNull(x.link) && (x.section_id !== null || x.idea === true)
  },

  view(action, live) {
    const params = p(action)
    const q = params.section_id ? live.sections.find((s) => s.id === params.section_id) : null
    const where = params.idea || !params.section_id ? 'Ideas' : (q?.title ?? 'a question')
    const link = params.link && safeHref(params.link)?.kind === 'external' ? params.link : null
    return {
      icon: '💡',
      title: params.idea ? 'Suggest an idea' : 'Suggest an option',
      rows: [
        { label: 'Suggestion', value: params.title.trim(), quoted: true, field: 'title' },
        { label: 'Goes in', value: where },
        ...(params.note?.trim() ? [{ label: 'Note', value: params.note.trim(), quoted: true }] : []),
        ...(link ? [{ label: 'Link', value: link }] : []),
      ],
      line: `Suggest "${params.title.trim()}" in ${where}`,
      confirmLabel: 'Suggest it',
      notes: [],
    }
  },

  recheck(action, live) {
    const params = p(action)
    if (live.finished) return FINISHED_CARD_MESSAGE
    if (params.section_id) {
      const q = live.sections.find((s) => s.id === params.section_id)
      if (!q) return 'That question is no longer there.'
      if (q.status === 'completed') return 'That question has been decided, so it is closed to new suggestions.'
    }
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    const link = params.link && safeHref(params.link)?.kind === 'external' ? params.link : undefined
    const res = await ctx.deps.suggestOption(ctx.tripId, {
      sectionId: params.section_id,
      title: params.title,
      link,
      note: params.note ?? undefined,
      ...(params.idea ? { idea: true } : {}),
    })
    return { result: { option_id: res.option_id, section_id: res.section_id }, doneText: params.idea ? 'Added to Ideas.' : 'Suggestion added.' }
  },

  invalidate(ctx) {
    invalidateAfterSuggestOption(ctx.queryClient, ctx.tripId)
  },
}
