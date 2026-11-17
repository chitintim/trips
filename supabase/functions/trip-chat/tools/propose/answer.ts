/**
 * propose_answer: record MY answer to a question (vote / approval / ranked / Own-choice order / pass / clear).
 * Executor: answerQuestion() over `params.answer_actions` (planAnswer + executeAnswerPlan). Rules are
 * answerModel's answerGate / planAnswer: the question must be Open, I must be in, options must be live and unlocked.
 */
import { z } from 'npm:zod@3'
import { readOptionPricing } from '../../../_shared/todos/deps/decisionShapes.ts'
import { refuse, type Json, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { AnswerActionJson, AnswerBasis, AnswerChosenRow, AnswerMode, AnswerParams, AnswerPreview } from './cards.ts'
import {
  baseBasis, dateTimeLabel, FINISHED_MESSAGE, gate, isOwnChoiceSection, loadOptions, loadSection, metaObject, NOT_FOUND_QUESTION,
  parseInput, storeProposal, tripState, uuid, line,
} from './common.ts'

const Input = z
  .object({
    question_id: uuid,
    op: z.enum(['pick', 'pass', 'clear']),
    option_ids: z.array(uuid).max(40),
    ranks: z.array(z.number().int().min(1).max(40)).max(40).nullable(),
    own_choice: z
      .array(
        z
          .object({
            option_id: uuid,
            quantity: z.number().int().min(1).max(99),
            variant: line(80).nullable(),
          })
          .strict(),
      )
      .max(40)
      .nullable(),
  })
  .strict()

export const answerSchema = {
  type: 'object',
  properties: {
    question_id: { type: 'string', format: 'uuid' },
    op: { type: 'string', enum: ['pick', 'pass', 'clear'], description: '"pick" records the options in option_ids (or own_choice for an Own-choice question); "pass" = No preference / None for me; "clear" removes my answer.' },
    option_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, description: 'The options to pick, in rank order for a ranked question (first = favourite). Empty for pass/clear and for own_choice.' },
    ranks: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Ranked questions only: rank (1 = best) for each option_ids entry in order. null = the order of option_ids.' },
    own_choice: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: {
          option_id: { type: 'string', format: 'uuid' },
          quantity: { type: 'integer' },
          variant: { type: ['string', 'null'] },
        },
        required: ['option_id', 'quantity', 'variant'],
        additionalProperties: false,
      },
      description: 'Own-choice questions only: the complete order for this person.',
    },
  },
  required: ['question_id', 'op', 'option_ids', 'ranks', 'own_choice'],
  additionalProperties: false,
}

function answerMode(s: { metadata: Json | null; voting_method: string | null }): AnswerMode {
  if (isOwnChoiceSection(s)) return 'own'
  if (s.voting_method === 'approval') return 'any'
  if (s.voting_method === 'ranked') return 'ranked'
  return 'single'
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

const MODE_LABEL: Record<AnswerMode, string> = {
  single: 'Pick one',
  any: 'Pick any that suit you',
  ranked: 'Rank your choices',
  own: 'Your own order',
}
const PASS_LABEL = { no_preference: 'No preference', none_for_me: 'None for me' } as const

function rowText(r: AnswerChosenRow, ranked: boolean): string {
  const rank = ranked && r.rank != null ? ` (${ordinal(r.rank)})` : ''
  const variant = r.variant ? ` (${r.variant})` : ''
  const qty = r.quantity != null && r.quantity > 1 ? ` × ${r.quantity}` : ''
  return `${r.title}${rank}${variant}${qty}`
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  const section = await loadSection(ctx, v.question_id)
  if (!section) return refuse(NOT_FOUND_QUESTION)
  const link = `Offer open_screen with target "question" and id "${section.id}" if they want to look at it.`
  if (section.status === 'completed') return refuse(`That question is decided, so answers are closed. ${link}`)

  const all = await loadOptions(ctx, section.id)
  const live = all.filter((o) => o.status !== 'cancelled')
  if (live.length === 0) return refuse('That question has no options to answer yet.')
  const byId = new Map(live.map((o) => [o.id, o]))
  const mode = answerMode(section)

  // My current answer (own rows, under the caller's JWT).
  const allIds = all.map((o) => o.id)
  const { data: voteRows } = await ctx.client.from('option_votes').select('option_id,user_id,rank').in('option_id', allIds).eq('user_id', ctx.userId)
  const { data: selRows } = await ctx.client.from('selections').select('option_id,user_id,metadata').in('option_id', allIds).eq('user_id', ctx.userId)
  const passRes = await ctx.client.from('question_passes').select('section_id,user_id,kind').eq('section_id', section.id).eq('user_id', ctx.userId)
  const passesKnown = !passRes.error
  const myVotes = ((voteRows ?? []) as Array<{ option_id: string; rank: number | null }>).filter((r) => byId.has(r.option_id) || allIds.includes(r.option_id))
  const mySels = ((selRows ?? []) as Array<{ option_id: string; metadata: Json | null }>)
  const myPass = passesKnown ? (((passRes.data ?? []) as Array<{ kind: string }>)[0]?.kind ?? null) as 'no_preference' | 'none_for_me' | null : null
  const hasAnswer = myVotes.length + mySels.length > 0

  const passKind = mode === 'own' ? 'none_for_me' : 'no_preference'
  let optionIds: string[] = []
  let ranks: number[] | null = null
  let ownChoice: AnswerParams['own_choice'] = null
  let actions: AnswerActionJson[] = []

  if (v.op === 'pass') {
    if (v.option_ids.length || v.ranks || v.own_choice) return refuse('A pass takes no options. Send empty option_ids and null ranks/own_choice.')
    if (!passesKnown) return refuse('"No preference" is not available on this trip yet. Offer open_screen for the question.')
    if (myPass === passKind && !hasAnswer) return refuse('You have already said that on this question.')
    actions = [{ type: 'pass' }]
  } else if (v.op === 'clear') {
    if (v.option_ids.length || v.ranks || v.own_choice) return refuse('Clearing takes no options. Send empty option_ids and null ranks/own_choice.')
    if (!hasAnswer && !myPass) return refuse('You have not answered this question, so there is nothing to clear.')
    actions = hasAnswer ? [{ type: 'clear' }] : [{ type: 'unpass' }]
  } else if (mode === 'own') {
    if (v.ranks) return refuse('Ranks are only for ranked questions.')
    const entries = v.own_choice ?? v.option_ids.map((id) => ({ option_id: id, quantity: 1, variant: null as string | null }))
    if (v.own_choice && v.option_ids.length) return refuse('For an Own-choice question send either option_ids or own_choice, not both.')
    if (entries.length === 0) return refuse('Pick at least one item, or use op "pass" for "None for me".')
    const seen = new Set<string>()
    for (const e of entries) {
      const opt = byId.get(e.option_id)
      if (!opt) return refuse('One of those options is not on this question (or was removed). Use option ids from the question.')
      if (seen.has(e.option_id)) return refuse('Each option can appear once.')
      seen.add(e.option_id)
      const pricing = readOptionPricing(opt.metadata)
      if (pricing && (pricing.per_day != null || (pricing.variants ?? []).some((x) => x.per_day != null))) {
        return refuse(`That item is priced per day and needs dates, which I cannot set. Offer open_screen with target "question" and id "${section.id}".`)
      }
      const variants = (pricing?.variants ?? []).map((x) => x.label)
      if (e.variant != null && !variants.includes(e.variant)) return refuse(`"${e.variant}" is not one of that item's options${variants.length ? ` (${variants.join(', ')})` : ' (it has none)'}.`)
    }
    ownChoice = entries.map((e) => ({ option_id: e.option_id, quantity: e.quantity, variant: e.variant ?? null }))
    optionIds = []
    actions = [{ type: 'save_own', items: ownChoice.map((e) => ({ optionId: e.option_id, checked: true as const, variant: e.variant, quantity: e.quantity })) }]
  } else {
    if (v.own_choice) return refuse('own_choice is only for Own-choice questions. Use option_ids.')
    if (v.option_ids.length === 0) return refuse('Pick at least one option, or use op "pass".')
    if (new Set(v.option_ids).size !== v.option_ids.length) return refuse('Each option can be picked once.')
    for (const id of v.option_ids) {
      const opt = byId.get(id)
      if (!opt) return refuse('One of those options is not on this question (or was removed). Use option ids from the question.')
      if (opt.locked) return refuse('One of those options is locked, so it cannot be picked.')
    }
    if (mode === 'single' && v.option_ids.length !== 1) return refuse('This question takes one answer. Send exactly one option.')
    if (mode === 'ranked') {
      if (v.ranks) {
        if (v.ranks.length !== v.option_ids.length) return refuse('ranks must have one entry per option_ids entry.')
        const sorted = [...v.ranks].sort((a, b) => a - b)
        if (!sorted.every((r, i) => r === i + 1)) return refuse('ranks must be 1..n with no gaps or repeats.')
        const ordered = v.option_ids.map((id, i) => ({ id, rank: v.ranks![i] })).sort((a, b) => a.rank - b.rank)
        optionIds = ordered.map((o) => o.id)
      } else optionIds = [...v.option_ids]
      ranks = optionIds.map((_, i) => i + 1)
    } else {
      if (v.ranks) return refuse('Ranks are only for ranked questions.')
      optionIds = [...v.option_ids]
    }
    // No change at all: nothing to confirm.
    const cur = new Set([...myVotes.map((r) => r.option_id), ...mySels.map((r) => r.option_id)])
    const sameSet = cur.size === optionIds.length && optionIds.every((id) => cur.has(id))
    const sameOrder = mode !== 'ranked' || optionIds.every((id, i) => myVotes.find((r) => r.option_id === id)?.rank === i + 1)
    if (sameSet && sameOrder && !myPass) return refuse('That is already your answer.')
    actions = mode === 'single'
      ? [{ type: 'pick', optionId: optionIds[0] }]
      : [...(hasAnswer ? [{ type: 'clear' as const }] : []), ...optionIds.map((id) => ({ type: 'pick' as const, optionId: id }))]
  }

  // Own-choice "same as now" check.
  if (v.op === 'pick' && mode === 'own' && ownChoice) {
    const cur = new Map(mySels.map((r) => [r.option_id, metaObject(r.metadata)]))
    const same = cur.size === ownChoice.length && ownChoice.every((e) => {
      const m = cur.get(e.option_id)
      if (!m) return false
      const q = typeof m.quantity === 'number' && m.quantity > 0 ? m.quantity : 1
      const variant = typeof m.variant === 'string' && m.variant ? m.variant : null
      return q === e.quantity && variant === e.variant
    })
    if (same) return refuse('That is already your order.')
  }

  const chosen: AnswerChosenRow[] = ownChoice
    ? ownChoice.map((e) => ({ option_id: e.option_id, title: byId.get(e.option_id)!.title, rank: null, quantity: e.quantity, variant: e.variant }))
    : optionIds.map((id, i) => ({ option_id: id, title: byId.get(id)!.title, rank: mode === 'ranked' ? i + 1 : null, quantity: null, variant: null }))

  const titleOf = (id: string) => all.find((o) => o.id === id)?.title ?? 'an option that was removed'
  let replaces: AnswerChosenRow[] | null = null
  if (mode === 'own' && mySels.length) {
    replaces = mySels.map((r) => {
      const m = metaObject(r.metadata)
      return { option_id: r.option_id, title: titleOf(r.option_id), rank: null, quantity: typeof m.quantity === 'number' ? m.quantity : 1, variant: typeof m.variant === 'string' && m.variant ? m.variant : null }
    })
  } else if (myVotes.length) {
    const ordered = [...myVotes].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    replaces = ordered.map((r) => ({ option_id: r.option_id, title: titleOf(r.option_id), rank: mode === 'ranked' ? r.rank : null, quantity: null, variant: null }))
  } else if (mySels.length) {
    replaces = mySels.map((r) => ({ option_id: r.option_id, title: titleOf(r.option_id), rank: null, quantity: null, variant: null }))
  }
  const replacesText = replaces
    ? replaces.map((r) => rowText(r, mode === 'ranked')).join(', ')
    : myPass
      ? PASS_LABEL[myPass]
      : null

  const params: AnswerParams = {
    section_id: section.id,
    mode,
    op: v.op,
    option_ids: optionIds,
    ranks,
    own_choice: ownChoice,
    pass_kind: v.op === 'pass' ? passKind : null,
    answer_actions: actions,
  }
  const preview: AnswerPreview = {
    question_title: section.title,
    mode_label: MODE_LABEL[mode],
    op_label: v.op === 'pass' ? PASS_LABEL[passKind] : v.op === 'clear' ? 'Remove your answer' : 'Record your answer',
    chosen: v.op === 'pick' ? chosen : [],
    replaces_text: replacesText,
    replaces,
    replaces_pass: myPass,
    deadline: section.vote_deadline ? dateTimeLabel(section.vote_deadline, ctx.today) : null,
    content_origin: {},
  }
  const basis: AnswerBasis = {
    ...baseBasis(ctx, state),
    section_status: section.status,
    section_updated_at: section.updated_at,
    option_status: Object.fromEntries(all.map((o) => [o.id, o.status])),
    my_previous: {
      votes: myVotes.map((r) => ({ optionId: r.option_id, rank: r.rank ?? null })),
      pass: myPass,
      selections: mySels.map((r) => ({ optionId: r.option_id, metadata: r.metadata })),
    },
  }
  return storeProposal(ctx, { kind: 'answer', params, preview, basis, requires: 'tap' })
}

export const proposeAnswer: ToolModule = {
  name: 'propose_answer',
  description:
    "Suggest recording the PERSON'S OWN answer to an open question (pick, rank, Own-choice order, No preference/None for me, or clear). Never for someone else. Nothing is recorded until they tap Confirm.",
  statusLabel: 'Preparing your answer…',
  inputSchema: answerSchema,
  run,
}
