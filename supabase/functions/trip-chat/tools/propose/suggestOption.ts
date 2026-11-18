/**
 * propose_suggest_option: a participant adds an option/idea to an open Group-choice question (or the
 * Ideas question). Same rules as src/features/decisions/lib/suggestOption.ts and the suggest_option RPC.
 * Organisers add to an EXISTING question with propose_add_option, but they may add an IDEA here: the RPC accepts
 * any active roster member (organisers included) and creates the Ideas question on first use with the same shape
 * the organiser's own Add flow writes. Executor: suggestOption(tripId, ...).
 */
import { z } from 'npm:zod@3'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { SuggestOptionBasis, SuggestOptionParams, SuggestOptionPreview } from './cards.ts'
import {
  baseBasis, cleanLine, FINISHED_MESSAGE, gate, isOwnChoiceSection, line, loadOptions, loadSection, metaObject, NOT_FOUND_QUESTION, note,
  originsFor, parseInput, storeProposal, tripState, uuid,
} from './common.ts'

export const SUGGEST_TITLE_MAX = 120
export const SUGGEST_NOTE_MAX = 500
export const SUGGEST_MAX_PER_QUESTION = 5
const MAX_OPTIONS = 60

/** Port of normalizeSuggestionLink: http(s) only, a bare "www." address gets https://. */
export function normalizeSuggestionLink(raw: string): string | null {
  const t = raw.trim()
  if (!t || /\s/.test(t)) return null
  if (/^https?:\/\/\S+$/i.test(t)) return t.length <= 2000 ? t : null
  if (/^www\.[^\s.]+\.\S+$/i.test(t)) return `https://${t}`.length <= 2000 ? `https://${t}` : null
  return null
}

const Input = z
  .object({
    question_id: uuid.nullable(),
    title: line(SUGGEST_TITLE_MAX),
    note: note(SUGGEST_NOTE_MAX),
    link: z.string().max(2000).nullable(),
  })
  .strict()

export const suggestOptionSchema = {
  type: 'object',
  properties: {
    question_id: { type: ['string', 'null'], format: 'uuid', description: 'The open question to add to (participants only; organisers use propose_add_option for a question). null = add it to the trip\'s Ideas list (everyone, organisers included).' },
    title: { type: 'string', description: 'Short title of the option or idea (up to 120 characters).' },
    note: { type: ['string', 'null'], description: 'Optional note (up to 500 characters).' },
    link: { type: ['string', 'null'], description: 'Optional http(s) link.' },
  },
  required: ['question_id', 'title', 'note', 'link'],
  additionalProperties: false,
}

function isDatePoll(title: string, options: Array<{ metadata: unknown }>): boolean {
  if (title.trim().toLowerCase() === 'trip dates') return true
  return options.some((o) => 'date_range' in metaObject(o.metadata as never))
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  if (ctx.me.canManageTrip && v.question_id) {
    return refuse('Organisers add options to a question directly: use propose_add_option (or propose_create_question for a new question). To add an idea to the Ideas list, call propose_suggest_option with question_id null.')
  }
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)

  let link: string | null = null
  if (v.link != null && cleanLine(v.link) !== '') {
    link = normalizeSuggestionLink(cleanLine(v.link))
    if (!link) return refuse('That link does not look right. Use the full address starting with http:// or https://, or send null.')
  }

  let sectionId: string | null = v.question_id
  let questionTitle = 'Ideas'
  let sectionStatus: string | null = null
  let sectionUpdated: string | null = null
  let optionCount: number | null = null
  let mine: number | null = null
  let isIdea = false

  if (v.question_id) {
    const s = await loadSection(ctx, v.question_id)
    if (!s) return refuse(NOT_FOUND_QUESTION)
    if (s.status === 'completed') return refuse('That question is decided, so it takes no more options.')
    if (isOwnChoiceSection(s)) return refuse('That is an Own-choice question (order form with prices), which cannot take a plain suggestion. Offer open_screen with target "question".')
    const opts = await loadOptions(ctx, s.id)
    if (isDatePoll(s.title, opts)) return refuse('Date polls cannot take a plain suggestion. Offer open_screen with target "question".')
    const live = opts.filter((o) => o.status !== 'cancelled')
    if (live.length >= MAX_OPTIONS) return refuse('That question already has the maximum number of options.')
    mine = live.filter((o) => metaObject(o.metadata).suggested_by === ctx.userId).length
    if (mine >= SUGGEST_MAX_PER_QUESTION) return refuse(`You have already suggested ${SUGGEST_MAX_PER_QUESTION} options on that question, which is the limit.`)
    if (live.some((o) => o.title.trim().toLowerCase() === v.title.toLowerCase())) return refuse('That question already has an option with the same title.')
    questionTitle = s.title
    sectionStatus = s.status
    sectionUpdated = s.updated_at
    optionCount = live.length
  } else {
    isIdea = true
    sectionId = null
    // The Ideas question may not exist yet (the RPC creates it on first use).
    const { data } = await ctx.client.from('planning_sections').select('id,title,metadata,status,updated_at').eq('trip_id', ctx.tripId)
    const ideas = ((data ?? []) as Array<{ id: string; title: string; metadata: unknown; status: string; updated_at: string | null }>).find(
      (r) => metaObject(r.metadata as never).ideas_bucket === true,
    )
    if (ideas) {
      const opts = (await loadOptions(ctx, ideas.id)).filter((o) => o.status !== 'cancelled')
      if (opts.some((o) => o.title.trim().toLowerCase() === v.title.toLowerCase())) return refuse('The Ideas list already has an idea with the same title.')
      mine = opts.filter((o) => metaObject(o.metadata).suggested_by === ctx.userId).length
      if (mine >= SUGGEST_MAX_PER_QUESTION) return refuse(`You have already suggested ${SUGGEST_MAX_PER_QUESTION} ideas, which is the limit.`)
      optionCount = opts.length
      sectionStatus = ideas.status
      sectionUpdated = ideas.updated_at
      questionTitle = ideas.title
    }
  }

  const params: SuggestOptionParams = { section_id: sectionId, idea: isIdea, title: v.title, note: v.note, link }
  const preview: SuggestOptionPreview = {
    title: v.title,
    note: v.note,
    link,
    question_title: questionTitle,
    is_idea: isIdea,
    content_origin: await originsFor(ctx, [{ field: 'title', text: v.title, sources: ['option', 'todo'] }]),
  }
  const basis: SuggestOptionBasis = { ...baseBasis(ctx, state), section_status: sectionStatus, section_updated_at: sectionUpdated, option_count: optionCount, my_suggestions: mine }
  return storeProposal(ctx, { kind: 'suggest_option', params, preview, basis, requires: 'review' })
}

export const proposeSuggestOption: ToolModule = {
  name: 'propose_suggest_option',
  description:
    'Suggest an idea for the trip\'s Ideas list (question_id null; anyone, organisers too), or an option on an open question (participants; organisers use propose_add_option for that). Nothing is added until the person confirms the card.',
  statusLabel: 'Preparing a suggestion…',
  inputSchema: suggestOptionSchema,
  run,
}
