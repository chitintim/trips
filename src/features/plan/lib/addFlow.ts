/**
 * Pure logic behind the three-intent Add sheet (redesign proposal 5.5, slice 4C).
 * No React, no Supabase: parsing, validation and the exact rows that get written.
 *
 * Mapping (no schema change):
 *  - Something that's happening -> `trip_timeline_events` (cost in `metadata.cost`).
 *  - A question for the group   -> `planning_sections` + `options`.
 *  - An idea                    -> one `options` row in the trip's "Ideas" question
 *                                  (a normal `planning_sections` row flagged with
 *                                  `metadata.ideas_bucket = true`), created on first use.
 */
import { IDEAS_BUCKET_KEY, IDEAS_QUESTION_TITLE, isIdeasBucket } from '../../../lib/ideasBucket'
import { withEventCost } from '../../../lib/cost/yourCost'
import { buildPricing, validatePricing, emptyPricing, defaultBasisForSection, type PricingFormValues } from '../../decisions/lib/optionPricingForm'
import { NEW_QUESTION_HIDE_RESULTS_DEFAULT } from '../../decisions/lib/answerModel'
import type { DecisionShape } from '../../decisions/lib/decisionShapes'
import type { PriceBasis } from '../../../lib/cost/priceBasis'
import type { Json, TablesInsert } from '../../../types/database.types'
import type { TimelineEventCategory } from '../../../types'

export type AddIntent = 'happening' | 'question' | 'idea'

/** Exact first-screen copy (proposal 5.5 / 5.8). */
export const INTENT_TILES: ReadonlyArray<{
  intent: AddIntent
  icon: string
  title: string
  hint: string
  saveLabel: string
}> = [
  { intent: 'happening', icon: '📅', title: 'Something that’s happening', hint: 'A dinner, a flight, a day out. It goes on the plan.', saveLabel: 'Add to plan' },
  { intent: 'question', icon: '❓', title: 'A question for the group', hint: 'Not sure yet? Give people options to answer.', saveLabel: 'Ask the group' },
  { intent: 'idea', icon: '💡', title: 'An idea', hint: 'Just a thought or a link. The group can look at it later.', saveLabel: 'Add idea' },
]

export { IDEAS_QUESTION_TITLE, IDEAS_BUCKET_KEY }

/**
 * The intents this viewer may save. People who can run the trip get all three. Everyone else who is coming
 * (`canSuggestIdea`, Phase 5A) gets exactly one, "An idea", which goes through the suggest RPC; they can
 * never create a happening or a question (RLS would refuse).
 */
export function availableIntents(canManageTrip: boolean, tripFinished = false, canSuggestIdea = false): AddIntent[] {
  if (!canManageTrip) return canSuggestIdea && !tripFinished ? ['idea'] : []
  // A finished trip has nothing left to ask or float: only recording what happened still makes sense.
  return tripFinished ? ['happening'] : ['happening', 'question', 'idea']
}

// ---------------------------------------------------------------------------
// Text parsing
// ---------------------------------------------------------------------------

const URL_RE = /^(https?:\/\/)\S+$/i

/** The URL when the whole (trimmed) text is one link, else null. Bare "www." links count. */
export function asPastedUrl(text: string): string | null {
  const t = text.trim()
  if (!t || /\s/.test(t)) return null
  if (URL_RE.test(t)) return t
  if (/^www\.[^\s.]+\.[^\s]+$/i.test(t)) return `https://${t}`
  return null
}

/** Strip list markers a pasted list brings with it: "- ", "• ", "1. ", "2) ". */
function stripMarker(line: string): string {
  return line.replace(/^\s*(?:[-*•–·]|\d{1,2}[.)])\s+/, '').trim()
}

/** One option per line; blanks and bullets dropped; case-insensitive duplicates removed. */
export function parseOptionLines(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarker(raw)
    if (!line) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

const CATEGORY_WORDS: ReadonlyArray<[RegExp, TimelineEventCategory]> = [
  [/\b(hotel|airbnb|hostel|check[- ]?in|check[- ]?out|chalet|villa|stay)\b/i, 'accommodation'],
  [/\b(transfer|shuttle|pick[- ]?up|drop[- ]?off)\b/i, 'transfer'],
  [/\b(flight|fly|flies|airport|boarding)\b/i, 'flight'],
  [/\b(train|bus|taxi|uber|ferry|metro|car hire|rental car|drive)\b/i, 'transport'],
  [/\b(dinner|lunch|breakfast|brunch|restaurant|cafe|café|drinks|bar|pub|tapas)\b/i, 'dining'],
  [/\b(meet|meeting|meet up|rendezvous)\b/i, 'meeting_point'],
  [/\b(free time|rest|downtime)\b/i, 'free_time'],
  [/\b(hike|tour|ski|skiing|lesson|museum|visit|beach|show|concert|match|game|spa|kayak|surf|trek|walk)\b/i, 'activity'],
]

/** Auto-guess the type from the title (no picker in the form). */
export function guessCategory(title: string): TimelineEventCategory {
  for (const [re, category] of CATEGORY_WORDS) if (re.test(title)) return category
  return 'other'
}

// ---------------------------------------------------------------------------
// 1. Something that's happening
// ---------------------------------------------------------------------------

export interface HappeningValues {
  title: string
  /** yyyy-mm-dd */
  day: string
  hasTime: boolean
  startTime: string
  endTime: string
  placeId: string | null
  placeName: string | null
  costAmount: string
  costCurrency: string
  costBasis: 'each' | 'total_split'
  notes: string
  /** Empty = everyone. */
  attendeeIds: string[]
}

export function emptyHappening(day: string, currency: string): HappeningValues {
  return { title: '', day, hasTime: false, startTime: '', endTime: '', placeId: null, placeName: null, costAmount: '', costCurrency: currency, costBasis: 'each', notes: '', attendeeIds: [] }
}

export function validateHappening(v: HappeningValues): string | null {
  if (!v.title.trim()) return 'What is happening? Add a title.'
  if (!v.day) return 'Pick a day.'
  if (v.hasTime && v.startTime && v.endTime && v.endTime < v.startTime) return 'The end time is before the start time.'
  if (v.costAmount.trim() !== '') {
    const n = Number(v.costAmount)
    if (!Number.isFinite(n) || n < 0) return 'Enter the cost as a number.'
  }
  return null
}

export function buildEventInsert(v: HappeningValues, tripId: string, userId: string): TablesInsert<'trip_timeline_events'> {
  const amount = v.costAmount.trim() === '' ? 0 : Number(v.costAmount)
  const timed = v.hasTime && !!v.startTime
  return {
    trip_id: tripId,
    created_by: userId,
    title: v.title.trim(),
    description: v.notes.trim() || null,
    category: guessCategory(v.title),
    event_date: v.day,
    all_day: !timed,
    start_time: timed ? v.startTime : null,
    end_time: timed ? v.endTime || null : null,
    place_id: v.placeId,
    location: v.placeName,
    participant_ids: v.attendeeIds.length > 0 ? v.attendeeIds : null,
    metadata: withEventCost(null, amount > 0 ? { amount, currency: v.costCurrency, basis: v.costBasis } : null),
  }
}

// ---------------------------------------------------------------------------
// 2. A question for the group
// ---------------------------------------------------------------------------

export type VotingMethodValue = 'single' | 'approval' | 'ranked'
export type StarterSectionType = 'accommodation' | 'transport' | 'activities'

/** One-tap starters above the question form. They only fill the title (and the guess for how the price is shared). */
export const QUESTION_TEMPLATES: ReadonlyArray<{ title: string; sectionType: StarterSectionType }> = [
  { title: 'Where are we staying?', sectionType: 'accommodation' },
  { title: 'How are we getting there?', sectionType: 'transport' },
  { title: 'What do we want to do?', sectionType: 'activities' },
]

export interface QuestionValues {
  title: string
  /** One option per line. */
  optionsText: string
  shape: DecisionShape
  method: VotingMethodValue
  /** datetime-local, '' = none */
  answerBy: string
  hideResults: boolean
  description: string
  sectionType: StarterSectionType
  /** Per parsed option title (lowercased) -> price text. */
  prices: Record<string, string>
  basis: PriceBasis
  currency: string
  nights: string
}

export function emptyQuestion(currency: string): QuestionValues {
  return {
    title: '', optionsText: '', shape: 'vote', method: 'single', answerBy: '',
    hideResults: NEW_QUESTION_HIDE_RESULTS_DEFAULT, description: '', sectionType: 'activities',
    prices: {}, basis: 'each', currency, nights: '',
  }
}

/** Picking a template fills the title, and defaults the price basis the way the option editor does (stay -> one shared total). */
export function applyTemplate(v: QuestionValues, templateTitle: string): QuestionValues {
  const t = QUESTION_TEMPLATES.find((x) => x.title === templateTitle)
  if (!t) return v
  return { ...v, title: t.title, sectionType: t.sectionType, basis: defaultBasisForSection(t.sectionType) }
}

function pricingFormFor(v: QuestionValues, price: string): PricingFormValues {
  return { ...emptyPricing(v.basis), price, currency: v.currency, nights: v.basis === 'per_night' ? v.nights : '' }
}

export function validateQuestion(v: QuestionValues): string | null {
  if (!v.title.trim()) return 'What do you want to ask? Add a question.'
  const options = parseOptionLines(v.optionsText)
  if (options.length < 2) return 'Add at least two options, one per line.'
  if (v.shape === 'vote') {
    for (const o of options) {
      const price = v.prices[o.toLowerCase()] ?? ''
      if (price.trim() === '') continue
      const err = validatePricing(pricingFormFor(v, price))
      if (err) return `${o}: ${err}`
    }
  }
  return null
}

export function buildSectionInsert(v: QuestionValues): Omit<TablesInsert<'planning_sections'>, 'trip_id'> {
  const metadata: Record<string, unknown> = { decision_shape: v.shape }
  // Legacy columns stay written so the rest of the app reads a normal row: section_type drives the
  // default cost scope, allow_multiple_selections is the old mirror of "Choose any", order_index sorts last-in-first.
  return {
    title: v.title.trim(),
    description: v.description.trim() || null,
    metadata: metadata as Json,
    section_type: v.sectionType,
    status: 'in_progress',
    allow_multiple_selections: v.shape === 'vote' && v.method === 'approval',
    order_index: 0,
    voting_method: v.shape === 'personal' ? 'single' : v.method,
    hide_votes_until_close: v.shape === 'vote' ? v.hideResults : NEW_QUESTION_HIDE_RESULTS_DEFAULT,
    vote_deadline: v.answerBy ? new Date(v.answerBy).toISOString() : null,
    quorum: null,
  }
}

/** Own-choice: a per-option price is catalog pricing (`metadata.pricing.flat`), as the order form reads it. */
export function buildQuestionOptionRows(v: QuestionValues, sectionId: string): Array<TablesInsert<'options'>> {
  return parseOptionLines(v.optionsText).map((title, i) => {
    const priceText = (v.prices[title.toLowerCase()] ?? '').trim()
    const base = { section_id: sectionId, title, order_index: i }
    if (priceText === '') return { ...base, price: null, currency: null, price_type: 'per_person_fixed' as const, metadata: null }
    if (v.shape === 'personal') {
      return { ...base, price: null, currency: v.currency, price_type: 'per_person_fixed' as const, metadata: { pricing: { flat: Number(priceText) } } as Json }
    }
    const built = buildPricing(pricingFormFor(v, priceText), null)
    return { ...base, price: built.price, currency: built.currency, price_type: built.price_type, metadata: built.metadata }
  })
}

// ---------------------------------------------------------------------------
// 3. An idea
// ---------------------------------------------------------------------------

export interface IdeaValues {
  title: string
  link: string
}

export function emptyIdea(): IdeaValues {
  return { title: '', link: '' }
}

export function validateIdea(v: IdeaValues): string | null {
  if (!v.title.trim()) return 'What is the idea? Add a title.'
  if (v.link.trim() && !asPastedUrl(v.link)) return 'That link doesn’t look right. Paste the full address, or leave it empty.'
  return null
}

interface SectionLike {
  id: string
  status: string
  title: string
  metadata?: Json | null
}

/** The trip's open Ideas question, if one exists. */
export function findIdeasQuestion<S extends SectionLike>(sections: readonly S[] | undefined): S | null {
  for (const s of sections ?? []) {
    if (isIdeasBucket(s) && s.status !== 'completed') return s
  }
  return null
}

/** The Ideas question: a normal "Choose any" group-choice question with results visible. */
export function buildIdeasSectionInsert(): Omit<TablesInsert<'planning_sections'>, 'trip_id'> {
  return {
    title: IDEAS_QUESTION_TITLE,
    description: 'Things people have suggested. Tell us which you like.',
    metadata: { decision_shape: 'vote', [IDEAS_BUCKET_KEY]: true } as Json,
    section_type: 'activities',
    status: 'in_progress',
    allow_multiple_selections: true,
    order_index: 0,
    voting_method: 'approval',
    hide_votes_until_close: NEW_QUESTION_HIDE_RESULTS_DEFAULT,
    vote_deadline: null,
    quorum: null,
  }
}

export function buildIdeaOptionRow(v: IdeaValues, sectionId: string): TablesInsert<'options'> {
  const url = asPastedUrl(v.link)
  return {
    section_id: sectionId,
    title: v.title.trim(),
    price: null,
    currency: null,
    price_type: 'per_person_fixed',
    metadata: url ? ({ source: 'link_parse', source_url: url } as Json) : null,
  }
}

// ---------------------------------------------------------------------------
// Saved toast
// ---------------------------------------------------------------------------

/** `?open=` target for the "View" action. Same formats as DEEP_LINKS in lib/todos/copy. */
export function viewLink(tripId: string, target: { type: 'question' | 'item'; id: string }): string {
  return `/${tripId}?open=${target.type}:${target.id}`
}
