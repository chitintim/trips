/** propose_add_option (organisers): add one option to an open question. Executor: createOption / the option editor insert. */
import { z } from 'npm:zod@3'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { AddOptionBasis, AddOptionParams, AddOptionPreview } from './cards.ts'
import { baseBasis, FINISHED_MESSAGE, gate, isOwnChoiceSection, line, loadOptions, loadSection, NOT_FOUND_QUESTION, note, originsFor, parseInput, storeProposal, tripState, uuid } from './common.ts'
import { BASIS_TEXT, OPTION_NOTE_MAX, OPTION_TITLE_MAX } from './createQuestion.ts'
import { formatMinor, isKnownCurrency, parseDecimalToMinor } from './money.ts'

const MAX_OPTIONS = 60

const Input = z
  .object({
    question_id: uuid,
    title: line(OPTION_TITLE_MAX),
    note: note(OPTION_NOTE_MAX),
    price: z.string().max(20).nullable(),
    currency: z.string().transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z]{3}$/)).nullable(),
    price_basis: z.enum(['each', 'total_split']).nullable(),
  })
  .strict()

export const addOptionSchema = {
  type: 'object',
  properties: {
    question_id: { type: 'string', format: 'uuid' },
    title: { type: 'string', description: 'Option title (up to 120 characters).' },
    note: { type: ['string', 'null'], description: 'Optional note (up to 500 characters).' },
    price: { type: ['string', 'null'], description: 'Decimal string, e.g. "120.00", or null.' },
    currency: { type: ['string', 'null'], description: '3-letter code; null = the trip currency.' },
    price_basis: { type: ['string', 'null'], enum: ['each', 'total_split', null] },
  },
  required: ['question_id', 'title', 'note', 'price', 'currency', 'price_basis'],
  additionalProperties: false,
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  if (!ctx.me.canManageTrip) {
    return refuse('Only organisers add options directly. Use propose_suggest_option to suggest this as an option instead.')
  }
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  const s = await loadSection(ctx, v.question_id)
  if (!s) return refuse(NOT_FOUND_QUESTION)
  if (s.status === 'completed') return refuse('That question is decided, so it takes no more options.')
  const live = (await loadOptions(ctx, s.id)).filter((o) => o.status !== 'cancelled')
  if (live.length >= MAX_OPTIONS) return refuse('That question already has the maximum number of options.')
  if (live.some((o) => o.title.trim().toLowerCase() === v.title.toLowerCase())) return refuse('That question already has an option with the same title.')

  let price: string | null = null
  let minor: number | null = null
  let currency: string | null = null
  let priceBasis: 'each' | 'total_split' | null = null
  if (v.price != null && v.price.trim() !== '') {
    currency = v.currency ?? ctx.trip.base_currency
    if (!isKnownCurrency(currency, ctx.trip.base_currency)) return refuse(`${currency} is not a currency the app knows.`)
    minor = parseDecimalToMinor(v.price, currency)
    if (minor == null || minor <= 0) return refuse(`"${v.price}" is not a price I can use: digits with at most the currency's decimals, more than zero.`)
    price = v.price.trim()
    priceBasis = isOwnChoiceSection(s) ? 'each' : v.price_basis ?? 'each'
  }

  const shape = isOwnChoiceSection(s) ? 'personal' : 'vote'
  const params: AddOptionParams = { section_id: s.id, shape, title: v.title, note: v.note, price, price_minor: minor, currency, price_basis: priceBasis }
  const preview: AddOptionPreview = {
    question_title: s.title,
    title: v.title,
    note: v.note,
    price_text: minor == null ? null : formatMinor(minor, currency!),
    basis_text: priceBasis ? BASIS_TEXT[priceBasis] : null,
    existing_option_count: live.length,
    content_origin: await originsFor(ctx, [{ field: 'title', text: v.title, sources: ['option', 'todo'] }]),
  }
  const basis: AddOptionBasis = { ...baseBasis(ctx, state), section_status: s.status, section_updated_at: s.updated_at, option_count: live.length }
  return storeProposal(ctx, { kind: 'add_option', params, preview, basis, requires: 'review' })
}

export const proposeAddOption: ToolModule = {
  name: 'propose_add_option',
  description:
    'ORGANISERS ONLY. Suggest adding one option (with an optional price) to an open question. Participants use propose_suggest_option. Nothing is added until an organiser confirms the card.',
  statusLabel: 'Preparing an option…',
  inputSchema: addOptionSchema,
  run,
}
