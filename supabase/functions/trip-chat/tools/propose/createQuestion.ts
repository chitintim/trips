/**
 * propose_create_question (organisers): a new question with its options in ONE action.
 * Mirrors addFlow.ts QuestionValues / buildSectionInsert / buildQuestionOptionRows.
 * Executor: createQuestionWithOptions(tripId, values).
 */
import { z } from 'npm:zod@3'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { CreateQuestionBasis, CreateQuestionParams, CreateQuestionPreview } from './cards.ts'
import { baseBasis, dateTimeLabel, FINISHED_MESSAGE, gate, line, note, originsFor, parseInput, storeProposal, tripState } from './common.ts'
import { formatMinor, isKnownCurrency, parseDecimalToMinor } from './money.ts'

export const QUESTION_TITLE_MAX = 120
export const OPTION_TITLE_MAX = 120
export const OPTION_NOTE_MAX = 500
export const MIN_OPTIONS = 2
export const MAX_NEW_OPTIONS = 15
export const SECTION_TYPES = ['accommodation', 'flights', 'transport', 'equipment', 'insurance', 'activities', 'lessons'] as const
export const PRICE_BASES = ['each', 'total_split'] as const

export const OPTION_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Option title (up to 120 characters).' },
    note: { type: ['string', 'null'], description: 'Optional note (up to 500 characters).' },
    price: { type: ['string', 'null'], description: 'Decimal string, e.g. "120.00", or null when there is no price.' },
    currency: { type: ['string', 'null'], description: '3-letter code for the price; null = the trip currency.' },
    price_basis: { type: ['string', 'null'], enum: ['each', 'total_split', null], description: '"each" = every person pays this; "total_split" = one total shared by everyone going. null = each.' },
  },
  required: ['title', 'note', 'price', 'currency', 'price_basis'],
  additionalProperties: false,
}

export const optionInput = z
  .object({
    title: line(OPTION_TITLE_MAX),
    note: note(OPTION_NOTE_MAX),
    price: z.string().max(20).nullable(),
    currency: z.string().transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z]{3}$/)).nullable(),
    price_basis: z.enum(PRICE_BASES).nullable(),
  })
  .strict()

const Input = z
  .object({
    title: line(QUESTION_TITLE_MAX),
    shape: z.enum(['group', 'own']),
    section_type: z.enum(SECTION_TYPES),
    voting: z.enum(['single', 'approval', 'ranked']),
    deadline: z.string().nullable(),
    options: z.array(optionInput).min(MIN_OPTIONS).max(MAX_NEW_OPTIONS),
  })
  .strict()

export const createQuestionSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The question, e.g. "Where shall we eat on Saturday?" (up to 120 characters).' },
    shape: { type: 'string', enum: ['group', 'own'], description: '"group" = everyone picks together (a vote); "own" = each person orders for themselves.' },
    section_type: { type: 'string', enum: [...SECTION_TYPES] },
    voting: { type: 'string', enum: ['single', 'approval', 'ranked'], description: 'single = pick one, approval = pick any, ranked = rank them. Own-choice questions ignore this.' },
    deadline: { type: ['string', 'null'], format: 'date-time', description: 'When answers close (ISO date-time in the future), or null.' },
    options: { type: 'array', items: OPTION_INPUT_SCHEMA, description: 'At least two options.' },
  },
  required: ['title', 'shape', 'section_type', 'voting', 'deadline', 'options'],
  additionalProperties: false,
}

const METHOD_LABEL = { single: 'Pick one', approval: 'Pick any that suit you', ranked: 'Rank your choices' } as const
export const BASIS_TEXT = { each: 'per person', total_split: 'one total, shared by everyone going' } as const

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  if (!ctx.me.canManageTrip) {
    return refuse('Only organisers can create a new question. Use propose_suggest_option to suggest an idea for an existing question or the Ideas list instead.')
  }
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  let answerBy: string | null = null
  if (v.deadline != null) {
    const t = Date.parse(v.deadline)
    if (Number.isNaN(t)) return refuse('deadline must be an ISO date-time such as 2026-11-20T18:00:00Z, or null.')
    if (t <= ctx.now.getTime()) return refuse('That deadline has already passed.')
    answerBy = new Date(t).toISOString()
  }

  const seen = new Set<string>()
  for (const o of v.options) {
    const k = o.title.toLowerCase()
    if (seen.has(k)) return refuse(`"${o.title}" appears twice. Each option needs a different title.`)
    seen.add(k)
  }

  // One currency and one basis across the priced options (a question has one of each).
  const priced = v.options.filter((o) => o.price != null && o.price.trim() !== '')
  const currencies = new Set(priced.map((o) => o.currency ?? ctx.trip.base_currency))
  if (currencies.size > 1) return refuse('All priced options on one question must use the same currency.')
  const currency = [...currencies][0] ?? ctx.trip.base_currency
  if (!isKnownCurrency(currency, ctx.trip.base_currency)) return refuse(`${currency} is not a currency the app knows.`)
  const bases = new Set(priced.map((o) => o.price_basis ?? 'each'))
  if (bases.size > 1) return refuse('All priced options on one question must use the same price basis (each or total_split).')
  const basisValue = ([...bases][0] ?? 'each') as 'each' | 'total_split'

  const options = []
  for (const o of v.options) {
    let minor: number | null = null
    if (o.price != null && o.price.trim() !== '') {
      minor = parseDecimalToMinor(o.price, currency)
      if (minor == null || minor <= 0) return refuse(`"${o.price}" is not a price I can use for "${o.title}": digits with at most the currency's decimals, more than zero.`)
    }
    options.push({ title: o.title, note: o.note, price: minor == null ? null : o.price!.trim(), price_minor: minor })
  }

  // An open question with the same title already exists?
  const { data: existing } = await ctx.client.from('planning_sections').select('id,title,status').eq('trip_id', ctx.tripId)
  if (((existing ?? []) as Array<{ title: string; status: string }>).some((s) => s.status !== 'completed' && s.title.trim().toLowerCase() === v.title.toLowerCase())) {
    return refuse('There is already an open question with that title. Offer open_screen with target "answer-all" or add an option with propose_add_option.')
  }

  const shape = v.shape === 'own' ? 'personal' : 'vote'
  const method = shape === 'personal' ? 'single' : v.voting
  const params: CreateQuestionParams = {
    title: v.title,
    shape,
    method,
    section_type: v.section_type,
    answer_by: answerBy,
    hide_results: false,
    currency,
    price_basis: shape === 'personal' ? 'each' : basisValue,
    options,
  }
  const preview: CreateQuestionPreview = {
    title: v.title,
    shape_label: shape === 'personal' ? 'Own choice: each person orders for themselves' : 'Group choice: everyone answers together',
    method_label: shape === 'personal' ? 'Own order' : METHOD_LABEL[method],
    deadline_label: answerBy ? dateTimeLabel(answerBy, ctx.today) : null,
    options: options.map((o) => ({
      title: o.title,
      note: o.note,
      price_text: o.price_minor == null ? null : formatMinor(o.price_minor, currency),
      basis_text: o.price_minor == null ? null : BASIS_TEXT[params.price_basis],
    })),
    content_origin: await originsFor(ctx, [{ field: 'title', text: v.title, sources: ['option', 'todo'] }]),
  }
  const basis: CreateQuestionBasis = baseBasis(ctx, state)
  return storeProposal(ctx, { kind: 'create_question', params, preview, basis, requires: 'review' })
}

export const proposeCreateQuestion: ToolModule = {
  name: 'propose_create_question',
  description:
    'ORGANISERS ONLY. Suggest a new question for the group with its options in one go (e.g. "Saturday dinner: Nando\'s, Wahaca, Dishoom, closes Thursday"). Participants cannot use this: they use propose_suggest_option. Nothing is created until an organiser confirms the card.',
  statusLabel: 'Preparing a question…',
  inputSchema: createQuestionSchema,
  run,
}
