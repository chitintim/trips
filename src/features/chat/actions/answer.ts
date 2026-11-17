import { answerGate, type AnswerAction, type ModelSection, type ModelViewer } from '../../decisions/lib/answerModel'
import { PASS_LABEL } from '../../decisions/lib/answerCopy'
import { readOrderItemMetadata } from '../../decisions/lib/decisionShapes'
import { invalidateAfterAnswer, previousAnswerOf, type PreviousAnswer } from '../../../lib/queries/usePlanning'
import type { AnswerParams } from '../lib/payload'
import type { ActionModule, LiveData } from './types'
import { formatDeadline, isInt, isNonEmptyStr, isObj, joinWords, ordinal } from './common'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as AnswerParams

function viewerFor(live: LiveData): ModelViewer {
  const me = live.roster.find((x) => x.user_id === live.userId)
  const out = !!me && (!me.active || me.confirmation_status === 'declined' || me.confirmation_status === 'cancelled')
  return { userId: live.userId, tripFinished: live.finished, out }
}

function optionTitle(section: LiveData['sections'][number], id: string): string | null {
  const o = section.options.find((x) => x.id === id && x.status !== 'cancelled')
  return o ? o.title : null
}

/** What I have answered now, read from the live data, in words. null = nothing. */
export function currentAnswerText(section: LiveData['sections'][number], live: LiveData): string | null {
  const prev = previousAnswerOf({ section, userId: live.userId, votes: live.votes, passes: live.passes })
  if (prev.selections.length) {
    return joinWords(prev.selections.map((s) => titleWithQty(section, s.optionId, readOrderItemMetadata(s.metadata))))
  }
  if (prev.votes.length) {
    const ranked = prev.votes.some((v) => v.rank != null)
    const ordered = [...prev.votes].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    return joinWords(ordered.map((v, i) => `${ranked ? `${ordinal(v.rank ?? i + 1)} ` : ''}${optionTitle(section, v.optionId) ?? 'an option that was removed'}`))
  }
  if (prev.pass) return PASS_LABEL[prev.pass]
  return null
}

function titleWithQty(section: LiveData['sections'][number], optionId: string, m: { quantity?: number; variant?: string }): string {
  const t = optionTitle(section, optionId) ?? 'an option that was removed'
  return `${m.quantity && m.quantity > 1 ? `${m.quantity} × ` : ''}${t}${m.variant ? ` (${m.variant})` : ''}`
}

function sameAnswer(live: LiveData, section: LiveData['sections'][number], basis: Record<string, unknown>): boolean {
  const before = basis.my_previous
  if (!isObj(before)) return true // no basis to compare: the gate and server still apply
  return answerEquals(live, section, before)
}

/** Is my answer on this question, read from the live data, the same as `before` ({votes, selections, pass})? */
function answerEquals(live: LiveData, section: LiveData['sections'][number], before: Record<string, unknown>): boolean {
  const now = previousAnswerOf({ section, userId: live.userId, votes: live.votes, passes: live.passes })
  const bv = Array.isArray(before.votes) ? (before.votes as Array<{ optionId?: string; rank?: number | null }>) : []
  const key = (v: { optionId?: string; rank?: number | null }) => `${v.optionId}:${v.rank ?? ''}`
  const a = bv.map(key).sort().join('|')
  const b = now.votes.map(key).sort().join('|')
  if (a !== b) return false
  const bs = Array.isArray(before.selections) ? (before.selections as Array<{ optionId?: string }>).map((s) => s.optionId).sort().join('|') : ''
  if (bs !== now.selections.map((s) => s.optionId).sort().join('|')) return false
  if (live.passes !== undefined && (before.pass ?? null) !== (now.pass ?? null)) return false
  return true
}

export function restoreActions(prev: Pick<PreviousAnswer, 'votes' | 'selections' | 'pass'>): AnswerAction[] {
  if (prev.selections.length) {
    return [
      {
        type: 'save_own',
        items: prev.selections.map((s) => {
          const m = readOrderItemMetadata(s.metadata)
          return { optionId: s.optionId, checked: true, variant: m.variant ?? null, quantity: m.quantity ?? 1 }
        }),
      },
    ]
  }
  if (prev.votes.length) {
    const ordered = [...prev.votes].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    return [{ type: 'clear' }, ...ordered.map((v) => ({ type: 'pick' as const, optionId: v.optionId }))]
  }
  if (prev.pass) return [{ type: 'clear' }, { type: 'pass' }]
  return [{ type: 'clear' }]
}

async function runActions(actions: AnswerAction[], sectionId: string, ctx: Parameters<NonNullable<ActionModule['undo']>>[1]): Promise<string | null> {
  let added: string | null = null
  for (const act of actions) {
    // Each step is planned from the true state (the previous step's writes included), like consecutive taps.
    await ctx.refresh()
    const live = ctx.live()
    const section = live.sections.find((s) => s.id === sectionId)
    if (!section) throw new Error('This question is no longer there.')
    const gate = answerGate(section as ModelSection, viewerFor(live))
    const res = await ctx.deps.answerQuestion({ section, userId: ctx.userId, gate, votes: live.votes, passes: live.passes, action: act })
    if (res.plan.addedOptionId && !added) added = res.plan.addedOptionId
  }
  return added
}

export const answerModule: ActionModule = {
  validate(x) {
    return (
      isNonEmptyStr(x.section_id) &&
      (x.op === 'pick' || x.op === 'pass' || x.op === 'clear') &&
      (x.mode === 'single' || x.mode === 'any' || x.mode === 'ranked' || x.mode === 'own') &&
      Array.isArray(x.option_ids) &&
      x.option_ids.every(isNonEmptyStr) &&
      Array.isArray(x.answer_actions) &&
      x.answer_actions.length > 0 &&
      x.answer_actions.length <= 12 &&
      x.answer_actions.every((a) => isObj(a) && ['pick', 'clear', 'pass', 'unpass', 'save_own'].includes(a.type as string) && (a.type !== 'pick' || isNonEmptyStr(a.optionId))) &&
      (x.own_choice == null || (Array.isArray(x.own_choice) && x.own_choice.every((o) => isObj(o) && isNonEmptyStr(o.option_id) && isInt(o.quantity))))
    )
  },

  view(action, live) {
    const params = p(action)
    const section = live.sections.find((s) => s.id === params.section_id)
    const qTitle = section?.title ?? 'a question'
    let chosen: string
    if (params.op === 'pass') chosen = PASS_LABEL[params.pass_kind ?? 'no_preference']
    else if (params.op === 'clear') chosen = 'Remove my answer'
    else if (params.mode === 'own') {
      chosen = joinWords((params.own_choice ?? []).map((o) => (section ? titleWithQty(section, o.option_id, { quantity: o.quantity, variant: o.variant ?? undefined }) : 'an option')))
    } else {
      const ids = params.option_ids
      chosen = joinWords(ids.map((id, i) => `${params.mode === 'ranked' ? `${ordinal(params.ranks?.[i] ?? i + 1)} ` : ''}${(section && optionTitle(section, id)) ?? 'an option that was removed'}`))
    }
    const replaces = section ? currentAnswerText(section, live) : null
    const rows = [
      { label: 'Question', value: qTitle },
      { label: params.op === 'clear' ? 'Change' : 'Your answer', value: chosen, quoted: params.op === 'pick' },
      ...(replaces ? [{ label: 'Replaces', value: replaces }] : []),
      ...(section?.vote_deadline ? [{ label: 'Answers close', value: formatDeadline(section.vote_deadline) }] : []),
    ]
    return {
      icon: '🗳️',
      title: params.op === 'clear' ? 'Remove your answer' : 'Record your answer',
      rows,
      line: params.op === 'pick' ? `Answer "${chosen}" on "${qTitle}"${replaces ? ` · replaces ${replaces}` : ''}` : `${chosen} on "${qTitle}"`,
      confirmLabel: params.op === 'clear' ? 'Remove answer' : 'Record answer',
      notes: [],
    }
  },

  recheck(action, live) {
    const params = p(action)
    const section = live.sections.find((s) => s.id === params.section_id)
    if (!section) return 'That question is no longer there.'
    const gate = answerGate(section as ModelSection, viewerFor(live))
    if (!gate.canAnswer && params.op !== 'clear') return gate.reason ?? 'Answers are closed on this question.'
    if (params.op === 'pick' || params.mode === 'own') {
      const ids = params.mode === 'own' ? (params.own_choice ?? []).map((o) => o.option_id) : params.option_ids
      if (ids.some((id) => !optionTitle(section, id))) return 'One of the options was removed.'
    }
    if (!sameAnswer(live, section, action.basis)) return 'Your answer changed since I suggested this.'
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    await ctx.refresh()
    const live = ctx.live()
    const section = live.sections.find((s) => s.id === params.section_id)
    if (!section) throw new Error('This question is no longer there.')
    const previous = previousAnswerOf({ section, userId: ctx.userId, votes: live.votes, passes: live.passes })
    const added = await runActions(params.answer_actions as AnswerAction[], params.section_id, ctx)
    if (added) {
      const label = section.options.find((o) => o.id === added)?.title
      ctx.logActivity({ verb: 'vote_cast', entity: { type: 'option', id: added, label }, metadata: { via: 'assistant', chat_action_id: action.id } })
    }
    // What my answer is right after the write: Undo is only offered while it is still exactly this.
    await ctx.refresh().catch(() => undefined)
    const after = ctx.live().sections.find((s) => s.id === params.section_id)
    const afterAnswer = after ? previousAnswerOf({ section: after, userId: ctx.userId, votes: ctx.live().votes, passes: ctx.live().passes }) : null
    return { result: { undo: { label: 'Put back your earlier answer', previous, ...(afterAnswer ? { after: afterAnswer } : {}) } }, doneText: 'Your answer is recorded.' }
  },

  undoBlocked(action, live) {
    const params = p(action)
    const section = live.sections.find((s) => s.id === params.section_id)
    if (!section) return 'This question is no longer there.'
    const undo = action.result?.undo
    const after = isObj(undo) ? undo.after : undefined
    // Without a record of what the answer became, there is no way to know it is unchanged.
    if (!isObj(after)) return 'Your answer can only be changed from the question itself now.'
    return answerEquals(live, section, after) ? null : 'Your answer has changed since, so it is left as it is.'
  },

  async undo(action, ctx) {
    const params = p(action)
    const prev = isObj(action.result?.undo) ? (action.result?.undo as { previous?: PreviousAnswer }).previous : undefined
    if (!prev || !Array.isArray(prev.votes) || !Array.isArray(prev.selections)) throw new Error('Nothing to undo.')
    await runActions(restoreActions(prev), params.section_id, ctx)
  },

  invalidate(ctx) {
    invalidateAfterAnswer(ctx.queryClient, ctx.tripId)
  },
}
