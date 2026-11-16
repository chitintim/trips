/**
 * Pure model behind AnswerControl / QuestionCard / useAnswer (proposal 5.3,
 * 5.4, 2.3). No React, no Supabase, fully unit-tested.
 *
 * Two directions:
 *   1. READ  `buildAnswerControlModel(...)`: a question + everyone's answers
 *      -> exactly what the control shows (rows, my answer, pass button, gate,
 *      results) for every shape.
 *   2. WRITE `planAnswer(...)`: a user action ("tap this option", "None for
 *      me", "save my order") -> the minimal set of table writes (the
 *      `AnswerPlan`). `useAnswer` executes the plan and applies it
 *      optimistically; nothing else decides what a tap writes.
 *
 * Shapes (all four existing copies of vote-casting collapse into this):
 *   'single'  Group choice, voting_method 'single'  -> option_votes, radio
 *   'any'     Group choice, 'approval'              -> option_votes, checkbox
 *   'ranked'  Group choice, 'ranked'                -> option_votes + rank (1..n by tap order)
 *   'own'     Own choice (decision_shape 'personal')-> selections (+ metadata: variant,
 *             quantity, start_date, end_date), incl. legacy migrated sections
 * Date questions (the "Trip dates" poll and any group choice whose options
 * carry `metadata.date_range`) are 'single'/'any' with `isDates: true`; rows
 * get a `dateLabel`.
 *
 * Reconciliation (proposal 2.3): a person has answered when they hold any of
 * vote / selection / pass (answers.ts). Writing a real answer clears the
 * person's pass; passing clears their real answer; the read side also lets a
 * real answer win if both ever exist (answers.ts). Group choices also treat a
 * person's leftover `selections` as approvals (read-time) and the plan removes
 * them when the person changes their answer, so one tap really changes it.
 */
import { areVotesVisible, type VotingMethod } from './voting'
import { resolveWinner } from './resolveDecision'
import {
  buildOrderItemMetadata,
  computeOrderItemTotal,
  readOptionPricing,
  type OptionPricing,
  readOrderItemMetadata,
  resolveVariantPricing,
  sumOrderLinesByCurrency,
  type OrderItemMetadata,
} from './decisionShapes'
import { formatCostImpact, formatMoney, getTierSensitivityLine, type CostImpactInput } from './costImpact'
import {
  answersFor,
  isOwnChoice,
  isTripFinished,
  liveOptionCount,
  passKindFor,
  type AnswerSection,
  type PassKind,
  type UserAnswer,
} from '../../../lib/answers/answers'
import type { Json } from '../../../types/database.types'
import {
  ANSWERS_CLOSED,
  GATE_REASON,
  INSTRUCTION,
  PASSED_SUMMARY,
  PASS_LABEL,
  RESULTS_HIDDEN,
  SELECTED_MARKER,
  TOAST_REMOVED,
  TOAST_SAVED,
  formatDateSpan,
  ordinal,
  peopleLabel,
} from './answerCopy'

// ---------------------------------------------------------------------------
// Owner default for NEW questions (proposal section 8)
// ---------------------------------------------------------------------------

/**
 * Results are visible while people answer, for NEW questions. Question
 * creation forms (slice 2B/2D: AddToPlanSheet, SectionEditorSheet) should
 * write `hide_votes_until_close: NEW_QUESTION_HIDE_RESULTS_DEFAULT`. The DB
 * column default is still `true`, and EXISTING questions keep whatever is
 * stored: the control only ever reads the stored value (`areVotesVisible`).
 */
export const NEW_QUESTION_HIDE_RESULTS_DEFAULT = false

// ---------------------------------------------------------------------------
// Input shapes (structural: generated rows and query results fit as-is)
// ---------------------------------------------------------------------------

export interface ModelSelection {
  id: string
  user_id: string
  metadata?: Json | null
}

export interface ModelOption {
  id: string
  title: string
  description?: string | null
  /** 'cancelled' options are hidden. */
  status?: string | null
  locked?: boolean | null
  price?: number | null
  currency?: string | null
  price_type?: string | null
  metadata?: Json | null
  order_index?: number | null
  created_at?: string | null
  /** Selections nested on the option (the shape `useSections` returns). */
  selections?: ReadonlyArray<ModelSelection> | null
}

export interface ModelSection {
  id: string
  status: string
  metadata?: Json | null
  voting_method?: string | null
  vote_deadline?: string | null
  hide_votes_until_close?: boolean | null
  options: ReadonlyArray<ModelOption>
}

export interface ModelVote {
  id: string
  option_id: string
  user_id: string
  rank?: number | null
  created_at?: string | null
}

export interface ModelPass {
  section_id: string
  user_id: string
  kind: PassKind
}

export interface ModelViewer {
  userId: string | null
  /** Trip is Finished (answers.ts `isTripFinished`). */
  tripFinished: boolean
  /** Viewer declined / cancelled / is inactive. */
  out?: boolean
}

/** A participant row as far as "is this person still answering?" is concerned. */
export interface ViewerRosterEntry {
  user_id: string
  active?: boolean | null
  confirmation_status?: string | null
}

/**
 * True when the viewer cannot answer because of who they are: signed out,
 * inactive, or declined / cancelled. (Not on the roster at all = not out: an
 * organizer who is not a participant is gated elsewhere by RLS, and the roster
 * may simply not have loaded yet.) The one rule behind the control, the card
 * chip and the plan list.
 */
export function isViewerOut(userId: string | null, participants: ReadonlyArray<ViewerRosterEntry>): boolean {
  if (!userId) return true
  const me = participants.find((p) => p.user_id === userId)
  return !!me && (me.active === false || me.confirmation_status === 'declined' || me.confirmation_status === 'cancelled')
}

/** The viewer as the gate sees them. */
export function buildModelViewer(
  userId: string | null,
  participants: ReadonlyArray<ViewerRosterEntry>,
  trip: { status: Parameters<typeof isTripFinished>[0]['status']; start_date: string; end_date: string },
  now: Date | string = new Date()
): ModelViewer {
  return { userId, tripFinished: isTripFinished(trip, now), out: isViewerOut(userId, participants) }
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

export type AnswerMode = 'single' | 'any' | 'ranked' | 'own'

export function answerMode(section: Pick<ModelSection, 'metadata' | 'voting_method'>): AnswerMode {
  if (isOwnChoice(section)) return 'own'
  if (section.voting_method === 'approval') return 'any'
  if (section.voting_method === 'ranked') return 'ranked'
  return 'single'
}

export function votingMethodOf(mode: AnswerMode): VotingMethod {
  return mode === 'any' ? 'approval' : mode === 'ranked' ? 'ranked' : 'single'
}

export function liveOptions(section: Pick<ModelSection, 'options'>): ModelOption[] {
  return section.options.filter((o) => o.status !== 'cancelled')
}

export interface DateRange {
  start: string
  end: string
}

/** `options.metadata.date_range` ({start, end}) as used by the "Trip dates" poll. */
export function readDateRange(metadata: Json | null | undefined): DateRange | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const r = (metadata as Record<string, unknown>).date_range
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null
  const { start, end } = r as Record<string, unknown>
  return typeof start === 'string' && typeof end === 'string' ? { start, end } : null
}

/** A group choice whose live options are dates. */
export function isDateQuestion(section: Pick<ModelSection, 'options' | 'metadata'>): boolean {
  if (isOwnChoice(section)) return false
  const live = liveOptions(section)
  return live.length > 0 && live.some((o) => readDateRange(o.metadata) !== null)
}

// ---------------------------------------------------------------------------
// Gate: can this person answer right now, and if not, why
// ---------------------------------------------------------------------------

export type GateState = 'open' | 'decided' | 'finished' | 'out' | 'no_options' | 'signed_out'

export interface AnswerGate {
  state: GateState
  canAnswer: boolean
  /** Sentence explaining why the control is disabled; null when open. */
  reason: string | null
  /** Short disabled label for the control chrome ("Answers closed"); null when open. */
  disabledLabel: string | null
}

/**
 * Order matters: a decided question stays "decided" even on a finished trip;
 * a finished trip beats "you're out"; signed-out beats everything but the
 * question's own status.
 */
export function answerGate(section: ModelSection, viewer: ModelViewer): AnswerGate {
  const closed = (state: GateState, reason: string): AnswerGate => ({ state, canAnswer: false, reason, disabledLabel: ANSWERS_CLOSED })
  if (section.status === 'completed') return closed('decided', GATE_REASON.decided)
  if (viewer.tripFinished) return closed('finished', GATE_REASON.finished)
  if (!viewer.userId) return { state: 'signed_out', canAnswer: false, reason: GATE_REASON.signedOut, disabledLabel: null }
  if (viewer.out) return { state: 'out', canAnswer: false, reason: GATE_REASON.out, disabledLabel: null }
  if (liveOptionCount(section as AnswerSection) === 0) {
    return { state: 'no_options', canAnswer: false, reason: GATE_REASON.noOptions, disabledLabel: null }
  }
  return { state: 'open', canAnswer: true, reason: null, disabledLabel: null }
}

// ---------------------------------------------------------------------------
// READ: the control model
// ---------------------------------------------------------------------------

export type RowIndicator = 'radio' | 'checkbox' | 'rank' | 'check'

export interface AnswerRow {
  optionId: string
  title: string
  description: string | null
  /** Date options: "17–21 Aug". */
  dateLabel: string | null
  selected: boolean
  /** Ranked: my 1-based rank; otherwise null. */
  rank: number | null
  /** "✓ Your answer" / "✓" / "1st", or null when not selected. */
  marker: string | null
  indicator: RowIndicator
  /** Tapping this row would be accepted (gate open and option not locked). */
  disabled: boolean
  disabledReason: string | null
  /** People who answered with this option; null while results are hidden. */
  count: number | null
  /** "4 people"; null while hidden or zero. */
  countLabel: string | null
  /** Who; empty while results are hidden. */
  voterIds: string[]
  /** True when this row is leading (results visible, not decided, strictly ahead). */
  leading: boolean
}

export interface OwnRow {
  optionId: string
  title: string
  description: string | null
  checked: boolean
  variant: string
  quantity: number
  startDate: string
  endDate: string
  /** Variant labels offered by the catalog item (empty = none). */
  variants: string[]
  /** Needs a from/to date (per-day rate, no flat rate). */
  needsDates: boolean
  perDay: number | null
  flat: number | null
  /** The catalog pricing spec (variants, per-day, flat), used to recompute totals as the draft changes. */
  pricing: OptionPricing | null
  currency: string
  /** This line's total in major units (0 when unchecked or unpriced). */
  total: number
  count: number | null
  countLabel: string | null
  voterIds: string[]
  disabled: boolean
  disabledReason: string | null
}

export interface PassModel {
  kind: PassKind
  label: string
  /** The passes query succeeded, so the button may show. False hides it. */
  visible: boolean
  /** I have passed on this question. */
  active: boolean
  disabled: boolean
}

export interface ResultsModel {
  visible: boolean
  /** "Results show when it's decided" while hidden (and the question is open). */
  hiddenNote: string | null
  /** "Leading: Osaka Airbnb (4)" / "Tied: A, B"; null when hidden, decided or nobody answered. */
  leaderLabel: string | null
  /** How many people answered (any way), for callers that want a bare number. */
  answeredCount: number
}

export interface AnswerControlModel {
  sectionId: string
  mode: AnswerMode
  isDates: boolean
  /** "Pick one" / "Pick any" / "Rank your top choices" / "Choose your own". */
  instruction: string
  gate: AnswerGate
  rows: AnswerRow[]
  /** Own choice only. */
  own: { rows: OwnRow[]; totalsByCurrency: Record<string, number>; totalLabel: string | null; hasChecked: boolean } | null
  myState: 'unanswered' | 'answered' | 'passed'
  /** "Your answer: Osaka Airbnb", "You said: No preference", "Your picks: Skis + boots × 2 · £86". */
  mySummary: string | null
  /** Group choices only: there is something to clear. */
  canClear: boolean
  pass: PassModel
  results: ResultsModel
}

export interface BuildControlInput {
  section: ModelSection
  viewer: ModelViewer
  votes: ReadonlyArray<ModelVote>
  /** `undefined` = the passes query failed / is unavailable: hides the pass button. */
  passes: ReadonlyArray<ModelPass> | undefined
  /** Own choice defaults for a row's date range (arrival/departure, else trip dates). */
  defaultDates?: { start: string; end: string }
  fallbackCurrency?: string
  now?: number
}

function sectionVotes(section: ModelSection, votes: ReadonlyArray<ModelVote>): ModelVote[] {
  const ids = new Set(section.options.map((o) => o.id))
  return votes.filter((v) => ids.has(v.option_id))
}

function mySelections(section: ModelSection, userId: string | null): Array<{ optionId: string; selection: ModelSelection }> {
  if (!userId) return []
  const out: Array<{ optionId: string; selection: ModelSelection }> = []
  for (const o of section.options) {
    for (const s of o.selections ?? []) if (s.user_id === userId) out.push({ optionId: o.id, selection: s })
  }
  return out
}

function myPassFor(section: ModelSection, userId: string | null, passes: ReadonlyArray<ModelPass> | undefined): ModelPass | null {
  if (!userId || !passes) return null
  return passes.find((p) => p.section_id === section.id && p.user_id === userId) ?? null
}

/** My ranked votes in order (rank asc; unranked legacy votes last by creation). */
function orderedMyVotes(votes: ReadonlyArray<ModelVote>): ModelVote[] {
  return [...votes].sort((a, b) => {
    const ra = a.rank ?? Number.MAX_SAFE_INTEGER
    const rb = b.rank ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return (a.created_at ?? '').localeCompare(b.created_at ?? '')
  })
}

/**
 * Metadata key an organiser sets (SectionEditorSheet) to hide who chose what on
 * an Own choice question until it is decided. Own choice ignores
 * `hide_votes_until_close`: that column defaults to true in the database, so
 * existing own-choice questions would otherwise have lost the "who ordered what"
 * view they always had.
 */
export const HIDE_OWN_CHOICE_ANSWERS_KEY = 'hide_own_choice_answers'

/** True when the organiser explicitly chose to hide an own-choice question's answers. */
export function ownChoiceAnswersHidden(metadata: Json | null | undefined): boolean {
  return !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) && (metadata as Record<string, Json>)[HIDE_OWN_CHOICE_ANSWERS_KEY] === true
}

/**
 * Can participants see who chose what on this question right now?
 *   Group choice: `hide_votes_until_close` (null/undefined counts as the DB default, true).
 *   Own choice:   visible, unless the metadata key above is true.
 * Either way: decided questions and a passed answer-by deadline reveal everything.
 */
export function areResultsVisible(
  section: Pick<ModelSection, 'metadata' | 'voting_method' | 'status' | 'vote_deadline' | 'hide_votes_until_close'>,
  now: number = Date.now()
): boolean {
  const hide = answerMode(section) === 'own' ? ownChoiceAnswersHidden(section.metadata) : section.hide_votes_until_close !== false
  return areVotesVisible({ vote_deadline: section.vote_deadline ?? null, hide_votes_until_close: hide, status: section.status }, now)
}

export function buildAnswerControlModel(input: BuildControlInput): AnswerControlModel {
  const { section, viewer, votes, passes } = input
  const now = input.now ?? Date.now()
  const mode = answerMode(section)
  const isDates = isDateQuestion(section)
  const gate = answerGate(section, viewer)
  const live = liveOptions(section)
  const userId = viewer.userId

  const secVotes = sectionVotes(section, votes)
  const answers = answersFor(section as AnswerSection, { votes: secVotes, passes: passes?.filter((p) => p.section_id === section.id) })
  const mine: UserAnswer | undefined = userId ? answers.get(userId) : undefined
  const myPass = myPassFor(section, userId, passes)
  const passKind = passKindFor(section)
  const passed = !!mine?.passed || !!myPass

  // Results: group choice reads hide_votes_until_close; own choice shows by
  // default and hides only on the explicit metadata key (see areResultsVisible).
  const visible = areResultsVisible(section, now)

  const countsByOption = new Map<string, string[]>()
  for (const a of answers.values()) {
    for (const id of a.optionIds) {
      const list = countsByOption.get(id) ?? []
      list.push(a.userId)
      countsByOption.set(id, list)
    }
  }

  // Leader (open questions only, results visible).
  let leaderOptionIds: string[] = []
  let leaderLabel: string | null = null
  if (visible && section.status !== 'completed' && live.length > 0) {
    if (mode === 'ranked') {
      const w = resolveWinner(
        { status: 'in_progress', metadata: section.metadata ?? null, voting_method: section.voting_method ?? null, options: live.map((o) => ({ id: o.id, status: o.status ?? 'available', order_index: o.order_index, created_at: o.created_at, metadata: o.metadata })) },
        secVotes,
        { ignoreStamp: true }
      )
      if (w.optionId) {
        leaderOptionIds = w.tied ? w.tiedOptionIds : [w.optionId]
        const titleOf = (id: string) => live.find((o) => o.id === id)?.title ?? ''
        leaderLabel = w.tied ? `Tied: ${leaderOptionIds.map(titleOf).join(', ')}` : `Leading: ${titleOf(w.optionId)}`
      }
    } else {
      const counts = live.map((o) => ({ o, n: countsByOption.get(o.id)?.length ?? 0 }))
      const top = Math.max(0, ...counts.map((c) => c.n))
      if (top > 0) {
        const tops = counts.filter((c) => c.n === top)
        leaderOptionIds = tops.map((c) => c.o.id)
        leaderLabel = tops.length > 1 ? `Tied: ${tops.map((c) => c.o.title).join(', ')} (${top} each)` : `Leading: ${tops[0].o.title} (${top})`
      }
    }
  }
  const strictLeader = leaderOptionIds.length === 1 ? leaderOptionIds[0] : null

  const answeredCount = answers.size
  const results: ResultsModel = {
    visible,
    hiddenNote: !visible && section.status !== 'completed' ? RESULTS_HIDDEN : null,
    leaderLabel,
    answeredCount,
  }

  const optionDisabled = (o: ModelOption): { disabled: boolean; reason: string | null } => {
    if (!gate.canAnswer) return { disabled: true, reason: gate.reason }
    if (o.locked) return { disabled: true, reason: GATE_REASON.locked }
    return { disabled: false, reason: null }
  }

  // ---- group rows -------------------------------------------------------
  const myRank = new Map<string, number>()
  const myOptionIds = new Set<string>()
  if (mode !== 'own' && mine) {
    for (const id of mine.optionIds) myOptionIds.add(id)
    if (mode === 'ranked') {
      // Ranks are tap order. Legacy ranked votes saved without a rank are
      // shown in creation order after the ranked ones.
      const ordered = orderedMyVotes(secVotes.filter((v) => v.user_id === userId))
      ordered.forEach((v, i) => myRank.set(v.option_id, v.rank ?? i + 1))
    }
  }

  const indicator: RowIndicator = mode === 'single' ? 'radio' : mode === 'any' ? 'checkbox' : mode === 'ranked' ? 'rank' : 'check'

  const rows: AnswerRow[] = mode === 'own' ? [] : live.map((o) => {
    const selected = myOptionIds.has(o.id)
    const rank = mode === 'ranked' && selected ? myRank.get(o.id) ?? null : null
    const voters = visible ? countsByOption.get(o.id) ?? [] : []
    const dr = readDateRange(o.metadata)
    const d = optionDisabled(o)
    return {
      optionId: o.id,
      title: o.title,
      description: o.description ?? null,
      dateLabel: dr ? formatDateSpan(dr.start, dr.end) : null,
      selected,
      rank,
      marker: !selected ? null : mode === 'ranked' ? ordinal(rank ?? 1) : SELECTED_MARKER[mode as Exclude<AnswerMode, 'ranked' | 'own'>],
      indicator,
      disabled: d.disabled,
      disabledReason: d.reason,
      count: visible ? voters.length : null,
      countLabel: visible && voters.length > 0 ? peopleLabel(voters.length) : null,
      voterIds: voters,
      leading: strictLeader === o.id,
    }
  })

  // ---- own rows ---------------------------------------------------------
  let own: AnswerControlModel['own'] = null
  const fallbackCurrency = input.fallbackCurrency || 'GBP'
  if (mode === 'own') {
    const defaults = input.defaultDates ?? { start: '', end: '' }
    const mineByOption = new Map(mySelections(section, userId).map((m) => [m.optionId, m.selection]))
    const ownRows: OwnRow[] = live.map((o) => {
      const sel = mineByOption.get(o.id)
      const item = sel ? readOrderItemMetadata(sel.metadata) : {}
      const voters = visible ? countsByOption.get(o.id) ?? [] : []
      const d = optionDisabled(o)
      return recomputeOwnRow(
        {
          optionId: o.id,
          title: o.title,
          description: o.description ?? null,
          checked: !!sel,
          variant: item.variant ?? '',
          quantity: item.quantity && item.quantity > 0 ? item.quantity : 1,
          startDate: item.start_date ?? defaults.start,
          endDate: item.end_date ?? defaults.end,
          variants: [],
          needsDates: false,
          perDay: null,
          flat: null,
          pricing: readOptionPricing(o.metadata),
          currency: o.currency || fallbackCurrency,
          total: 0,
          count: visible ? voters.length : null,
          countLabel: visible && voters.length > 0 ? peopleLabel(voters.length) : null,
          voterIds: voters,
          disabled: d.disabled,
          disabledReason: d.reason,
        },
        {}
      )
    })
    own = { ...ownTotals(ownRows, fallbackCurrency), rows: ownRows }
  }

  // ---- my state + summary ----------------------------------------------
  const hasRealAnswer = !!mine && mine.optionIds.size > 0
  const myState: AnswerControlModel['myState'] = hasRealAnswer ? 'answered' : passed ? 'passed' : 'unanswered'

  let mySummary: string | null = null
  if (myState === 'passed') {
    mySummary = PASSED_SUMMARY[myPass?.kind ?? mine?.passKind ?? passKind]
  } else if (myState === 'answered') {
    if (mode === 'own' && own) {
      mySummary = ownSummary(own.rows, own.totalLabel)
    } else if (mode === 'ranked') {
      const ordered = rows.filter((r) => r.selected).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
      mySummary = `Your ranking: ${ordered.map((r) => `${ordinal(r.rank ?? 1)} ${r.title}`).join(', ')}`
    } else {
      const picked = rows.filter((r) => r.selected).map((r) => r.dateLabel ?? r.title)
      mySummary = `${picked.length > 1 ? 'Your answers' : 'Your answer'}: ${picked.join(', ')}`
    }
  }

  const pass: PassModel = {
    kind: passKind,
    label: PASS_LABEL[passKind],
    visible: passes !== undefined && gate.state !== 'no_options' && gate.state !== 'signed_out',
    active: passed && !hasRealAnswer,
    disabled: !gate.canAnswer,
  }

  return {
    sectionId: section.id,
    mode,
    isDates,
    instruction: INSTRUCTION[mode],
    gate,
    rows,
    own,
    myState,
    mySummary,
    canClear: mode !== 'own' && (hasRealAnswer || mySelections(section, userId).length > 0),
    pass,
    results,
  }
}

/** Totals for the "Your total" line of an order. */
export function ownTotals(
  rows: ReadonlyArray<Pick<OwnRow, 'checked' | 'optionId' | 'title' | 'variant' | 'quantity' | 'startDate' | 'endDate' | 'currency' | 'total'>>,
  fallbackCurrency = 'GBP'
): { totalsByCurrency: Record<string, number>; totalLabel: string | null; hasChecked: boolean } {
  const lines = rows
    .filter((r) => r.checked)
    .map((r) => ({
      optionId: r.optionId,
      optionTitle: r.title,
      variant: r.variant || null,
      quantity: r.quantity,
      startDate: r.startDate || null,
      endDate: r.endDate || null,
      total: r.total,
      currency: r.currency || fallbackCurrency,
    }))
  const totalsByCurrency = sumOrderLinesByCurrency(lines)
  const entries = Object.entries(totalsByCurrency).filter(([, amount]) => amount > 0)
  return {
    totalsByCurrency,
    totalLabel: entries.length === 0 ? null : entries.map(([currency, amount]) => formatMoney(amount, currency)).join(' + '),
    hasChecked: lines.length > 0,
  }
}

/**
 * Recompute everything derived on an order row after an edit (a variant
 * changes the rate; dates and quantity change the total; unchecking zeroes it).
 */
export function recomputeOwnRow(
  row: OwnRow,
  patch: Partial<Pick<OwnRow, 'checked' | 'variant' | 'quantity' | 'startDate' | 'endDate'>>
): OwnRow {
  const next: OwnRow = { ...row, ...patch }
  next.quantity = next.quantity >= 1 ? Math.floor(next.quantity) : 1
  const rate = next.pricing ? resolveVariantPricing(next.pricing, next.variant || undefined) : {}
  next.variants = next.pricing?.variants?.map((v) => v.label) ?? []
  next.perDay = rate.per_day ?? null
  next.flat = rate.flat ?? null
  next.needsDates = rate.per_day != null && rate.flat == null
  next.total =
    next.checked && next.pricing
      ? computeOrderItemTotal(
          next.pricing,
          { start_date: next.startDate || undefined, end_date: next.endDate || undefined, variant: next.variant || undefined, quantity: next.quantity },
          next.currency
        )
      : 0
  return next
}

/** The `save_own` payload for a draft order. */
export function ownRowsToItems(rows: ReadonlyArray<OwnRow>): OwnItemInput[] {
  return rows.map((r) => ({
    optionId: r.optionId,
    checked: r.checked,
    variant: r.variant || null,
    quantity: r.quantity,
    // Same as the old order form: dates are always saved (defaults are the
    // person's arrival/departure or the trip dates).
    startDate: r.startDate || null,
    endDate: r.endDate || null,
  }))
}

/**
 * The existing per-option cost text (placeholder until Phase 3's one money
 * display): "+£54/person" / "≈£50/person at 9 people", plus the tier
 * sensitivity line. Both null when the option has no price.
 */
export function optionCostLines(
  option: { price: number | null; currency: string | null; price_type: CostImpactInput['priceType']; metadata?: Json | null },
  headcount: { count: number; isEstimate: boolean }
): { text: string | null; sensitivity: string | null } {
  const input: CostImpactInput = {
    price: option.price,
    currency: option.currency,
    priceType: option.price_type,
    confirmedCount: headcount.count,
    isEstimate: headcount.isEstimate,
    metadata: option.metadata,
  }
  return { text: formatCostImpact(input), sensitivity: getTierSensitivityLine(input) }
}

/** "Your picks: Skis + boots × 2, Helmet · £86" */
export function ownSummary(rows: ReadonlyArray<Pick<OwnRow, 'checked' | 'title' | 'quantity' | 'variant'>>, totalLabel: string | null): string {
  const picks = rows
    .filter((r) => r.checked)
    .map((r) => `${r.title}${r.variant ? ` (${r.variant})` : ''}${r.quantity > 1 ? ` × ${r.quantity}` : ''}`)
  return `Your picks: ${picks.join(', ')}${totalLabel ? ` · ${totalLabel}` : ''}`
}

// ---------------------------------------------------------------------------
// WRITE: from a user action to table writes
// ---------------------------------------------------------------------------

export interface OwnItemInput {
  optionId: string
  checked: boolean
  variant?: string | null
  quantity?: number
  startDate?: string | null
  endDate?: string | null
}

export type AnswerAction =
  /** Tap an option row (group choices): toggles in 'any'/'ranked', replaces in 'single'. */
  | { type: 'pick'; optionId: string }
  /** Remove my answer (group choices) or all my picks (own). */
  | { type: 'clear' }
  /** "No preference" / "None for me". */
  | { type: 'pass' }
  /** Take the pass back without answering. */
  | { type: 'unpass' }
  /** Own choice: the complete desired state of my order (explicit Save). */
  | { type: 'save_own'; items: ReadonlyArray<OwnItemInput> }

/** Same shape as `OrderItemChange` in usePlanning (metadata null = delete the row). */
export interface SelectionChange {
  optionId: string
  selectionId: string | null
  metadata: Json | null
}

export type PassWrite =
  /**
   * `replaceExisting`: a pass of ANOTHER kind is already stored (for example
   * "No preference" on a question that has since become an own choice). The
   * table has no UPDATE grant and the insert ignores duplicates, so the stale
   * row must be deleted first. Safe: deleting a pass never loses a real answer.
   */
  | { op: 'set'; kind: PassKind; replaceExisting?: boolean }
  | { op: 'clear' }

export interface AnswerPlan {
  sectionId: string
  userId: string
  /** option_votes rows to upsert (onConflict option_id,user_id). */
  voteUpserts: Array<{ optionId: string; rank: number | null }>
  /** option_votes rows to delete (ids are persisted ids or `optimistic-` ids). */
  voteDeletes: Array<{ id: string; optionId: string }>
  /** selections to insert / update / delete. */
  selectionChanges: SelectionChange[]
  pass: PassWrite | null
  /** Toast wording key: 'saved' = "Answer saved", 'removed' = "Answer removed". */
  outcome: 'saved' | 'removed'
  toast: string
  /** Nothing to write (e.g. nothing changed). */
  noop: boolean
  /** The option that was newly voted for (activity log), if any. */
  addedOptionId: string | null
}

export type PlanResult = { ok: true; plan: AnswerPlan } | { ok: false; reason: string }

export interface PlanInput {
  section: ModelSection
  userId: string
  gate: AnswerGate
  /** Any votes; mine on this section are picked out. */
  votes: ReadonlyArray<ModelVote>
  /** My current pass. `undefined` = passes unavailable (never write or clear a pass). */
  passes: ReadonlyArray<ModelPass> | undefined
}

function emptyPlan(section: ModelSection, userId: string): AnswerPlan {
  return {
    sectionId: section.id,
    userId,
    voteUpserts: [],
    voteDeletes: [],
    selectionChanges: [],
    pass: null,
    outcome: 'saved',
    toast: TOAST_SAVED,
    noop: false,
    addedOptionId: null,
  }
}

function finish(plan: AnswerPlan): AnswerPlan {
  const noop = plan.voteUpserts.length === 0 && plan.voteDeletes.length === 0 && plan.selectionChanges.length === 0 && plan.pass === null
  return { ...plan, noop, toast: plan.outcome === 'removed' ? TOAST_REMOVED : TOAST_SAVED }
}

/** Renumber an ordered list of option ids to ranks 1..n, emitting upserts only where the stored rank differs. */
function renumber(orderedOptionIds: string[], current: Map<string, number | null>): Array<{ optionId: string; rank: number | null }> {
  const out: Array<{ optionId: string; rank: number | null }> = []
  orderedOptionIds.forEach((optionId, i) => {
    const rank = i + 1
    if (current.get(optionId) !== rank) out.push({ optionId, rank })
  })
  return out
}

function normaliseOwnMetadata(item: OwnItemInput): OrderItemMetadata {
  const meta: OrderItemMetadata = {}
  if (item.startDate) meta.start_date = item.startDate
  if (item.endDate) meta.end_date = item.endDate
  if (item.variant) meta.variant = item.variant
  meta.quantity = item.quantity && item.quantity > 0 ? Math.floor(item.quantity) : 1
  return meta
}

const ORDER_METADATA_KEYS = ['start_date', 'end_date', 'variant', 'quantity'] as const

/**
 * The metadata to store on an EXISTING selection: its current object with the
 * four keys the order form owns (start_date, end_date, variant, quantity)
 * replaced by the new values (a key the new value omits is removed, exactly
 * as the old form rewrote them), and every other key left untouched.
 */
export function mergeOrderMetadata(existing: Json | null | undefined, next: OrderItemMetadata): Json {
  const base: Record<string, unknown> = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {}
  for (const k of ORDER_METADATA_KEYS) delete base[k]
  return { ...base, ...next } as unknown as Json
}

function sameOrderMetadata(a: OrderItemMetadata, b: OrderItemMetadata): boolean {
  return (a.start_date ?? '') === (b.start_date ?? '') && (a.end_date ?? '') === (b.end_date ?? '') && (a.variant ?? '') === (b.variant ?? '') && (a.quantity ?? 1) === (b.quantity ?? 1)
}

/**
 * Turn a user action into writes. Never touches the network. Callers must
 * pass the CURRENT answers; `useAnswer` reads them from the query cache at
 * the moment of the action.
 */
export function planAnswer(input: PlanInput, action: AnswerAction): PlanResult {
  const { section, userId, gate } = input
  const mode = answerMode(section)
  if (!gate.canAnswer) return { ok: false, reason: gate.reason ?? ANSWERS_CLOSED }

  const live = liveOptions(section)
  const liveIds = new Set(live.map((o) => o.id))
  const myVotes = sectionVotes(section, input.votes).filter((v) => v.user_id === userId)
  const mySels = mySelections(section, userId)
  const myPass = myPassFor(section, userId, input.passes)
  const passKind = passKindFor(section)
  const passesKnown = input.passes !== undefined
  const plan = emptyPlan(section, userId)

  // Real answers are cleared when a pass is set; a pass is cleared when a real answer is written.
  const clearPassIfAny = () => {
    if (passesKnown && myPass) plan.pass = { op: 'clear' }
  }
  const dropAllRealAnswers = () => {
    for (const v of myVotes) plan.voteDeletes.push({ id: v.id, optionId: v.option_id })
    for (const s of mySels) plan.selectionChanges.push({ optionId: s.optionId, selectionId: s.selection.id, metadata: null })
  }

  switch (action.type) {
    case 'pass': {
      if (!passesKnown) return { ok: false, reason: 'unavailable' }
      dropAllRealAnswers()
      if (!myPass || myPass.kind !== passKind) plan.pass = myPass ? { op: 'set', kind: passKind, replaceExisting: true } : { op: 'set', kind: passKind }
      plan.outcome = 'saved'
      return { ok: true, plan: finish(plan) }
    }

    case 'unpass': {
      if (passesKnown && myPass) plan.pass = { op: 'clear' }
      plan.outcome = 'removed'
      return { ok: true, plan: finish(plan) }
    }

    case 'clear': {
      dropAllRealAnswers()
      plan.outcome = 'removed'
      return { ok: true, plan: finish(plan) }
    }

    case 'save_own': {
      if (mode !== 'own') return { ok: false, reason: 'not_own_choice' }
      const byOption = new Map(action.items.map((i) => [i.optionId, i]))
      const existing = new Map(mySels.map((m) => [m.optionId, m.selection]))
      let checkedCount = 0
      for (const o of section.options) {
        // Never touch rows on options that are no longer live (cancelled): the
        // person cannot see them in the form, so re-saving must not delete
        // (or rewrite) picks they never knowingly removed.
        if (!liveIds.has(o.id)) continue
        const item = byOption.get(o.id)
        const sel = existing.get(o.id)
        const wants = !!item?.checked
        if (!wants) {
          if (sel) plan.selectionChanges.push({ optionId: o.id, selectionId: sel.id, metadata: null })
          continue
        }
        checkedCount += 1
        const meta = normaliseOwnMetadata(item!)
        if (sel) {
          if (!sameOrderMetadata(readOrderItemMetadata(sel.metadata), meta)) {
            plan.selectionChanges.push({ optionId: o.id, selectionId: sel.id, metadata: mergeOrderMetadata(sel.metadata, meta) })
          }
        } else {
          plan.selectionChanges.push({ optionId: o.id, selectionId: null, metadata: buildOrderItemMetadata(meta) })
        }
      }
      if (checkedCount > 0) {
        clearPassIfAny()
        plan.outcome = 'saved'
      } else {
        // Saving an empty order withdraws the answer (does not pass).
        plan.outcome = 'removed'
      }
      return { ok: true, plan: finish(plan) }
    }

    case 'pick': {
      if (mode === 'own') return { ok: false, reason: 'use_save_own' }
      const option = live.find((o) => o.id === action.optionId)
      if (!option) return { ok: false, reason: 'unknown_option' }
      if (option.locked) return { ok: false, reason: GATE_REASON.locked }
      const myVote = myVotes.find((v) => v.option_id === option.id)
      const mySel = mySels.find((s) => s.optionId === option.id)
      const selected = !!myVote || !!mySel

      // Toggle off.
      if (selected) {
        if (myVote) plan.voteDeletes.push({ id: myVote.id, optionId: option.id })
        if (mySel) plan.selectionChanges.push({ optionId: option.id, selectionId: mySel.selection.id, metadata: null })
        if (mode === 'ranked') {
          const remaining = orderedMyVotes(myVotes.filter((v) => v.option_id !== option.id))
          plan.voteUpserts.push(...renumber(remaining.map((v) => v.option_id), new Map(remaining.map((v) => [v.option_id, v.rank ?? null]))))
        }
        plan.outcome = 'removed'
        return { ok: true, plan: finish(plan) }
      }

      // Add.
      if (mode === 'single') {
        // Radio: the new choice replaces everything else I had here.
        for (const v of myVotes) plan.voteDeletes.push({ id: v.id, optionId: v.option_id })
        for (const s of mySels) plan.selectionChanges.push({ optionId: s.optionId, selectionId: s.selection.id, metadata: null })
        plan.voteUpserts.push({ optionId: option.id, rank: null })
      } else if (mode === 'ranked') {
        const ordered = orderedMyVotes(myVotes)
        const orderedIds = [...ordered.map((v) => v.option_id), option.id]
        const current = new Map<string, number | null>(ordered.map((v) => [v.option_id, v.rank ?? null]))
        plan.voteUpserts.push(...renumber(orderedIds, current))
      } else {
        plan.voteUpserts.push({ optionId: option.id, rank: null })
      }
      plan.addedOptionId = option.id
      clearPassIfAny()
      plan.outcome = 'saved'
      return { ok: true, plan: finish(plan) }
    }
  }
}

// ---------------------------------------------------------------------------
// Write order (pure, so the "never delete before the replacement is stored"
// rule is testable without a network)
// ---------------------------------------------------------------------------

export type AnswerStep =
  | { type: 'pass_delete'; sectionId: string; userId: string; reason: 'stale_kind' | 'clear' }
  | { type: 'pass_set'; sectionId: string; userId: string; kind: PassKind }
  | { type: 'votes_upsert'; userId: string; rows: Array<{ optionId: string; rank: number | null }> }
  /** Delete votes by persisted id (rows must exist). */
  | { type: 'votes_delete_ids'; userId: string; ids: string[] }
  /** Delete votes by option id (the row was still optimistic when planned). */
  | { type: 'votes_delete_options'; userId: string; optionIds: string[] }
  | { type: 'selection'; userId: string; change: SelectionChange }

/**
 * The exact order a plan is written in. The rule: a failure part-way must
 * leave a consistent state and never lose an answer the person still wants.
 *
 *  - Pass:          store the pass FIRST, then remove the answers. A real answer
 *                   beats a pass when both exist (answers.ts), so a failure in
 *                   between leaves the old answer, which is a valid state. A pass
 *                   of another kind is deleted first (deleting a pass loses no
 *                   real answer).
 *  - New answer:    write the new vote / selection FIRST, then delete the
 *                   replaced ones (choose-one swap), then clear the pass last.
 *                   A failed delete leaves two picks that the next tap repairs.
 *  - Pure removal   (untick an option, ranked "tap again"): nothing replaces the
 *                   deleted row, so delete first, then renumber the remaining
 *                   ranks. A failure between them leaves a gap (2, 3), which
 *                   still sorts correctly, never duplicate ranks.
 *  - Unpass:        delete the pass only.
 */
export function orderedSteps(plan: AnswerPlan): AnswerStep[] {
  const { userId, sectionId } = plan
  const steps: AnswerStep[] = []

  const persisted = plan.voteDeletes.filter((d) => !d.id.startsWith('optimistic-'))
  const optimisticOptionIds = plan.voteDeletes.filter((d) => d.id.startsWith('optimistic-')).map((d) => d.optionId)
  const voteDeletes = (): AnswerStep[] => {
    const out: AnswerStep[] = []
    if (persisted.length > 0) out.push({ type: 'votes_delete_ids', userId, ids: persisted.map((d) => d.id) })
    if (optimisticOptionIds.length > 0) out.push({ type: 'votes_delete_options', userId, optionIds: optimisticOptionIds })
    return out
  }
  const voteUpserts = (): AnswerStep[] => (plan.voteUpserts.length > 0 ? [{ type: 'votes_upsert', userId, rows: plan.voteUpserts }] : [])
  const writes = plan.selectionChanges.filter((c) => c.metadata !== null)
  const removals = plan.selectionChanges.filter((c) => c.metadata === null)
  const sel = (list: SelectionChange[]): AnswerStep[] => list.map((change) => ({ type: 'selection', userId, change }))

  if (plan.pass?.op === 'set') {
    if (plan.pass.replaceExisting) steps.push({ type: 'pass_delete', sectionId, userId, reason: 'stale_kind' })
    steps.push({ type: 'pass_set', sectionId, userId, kind: plan.pass.kind })
    steps.push(...voteUpserts(), ...sel(writes), ...voteDeletes(), ...sel(removals))
    return steps
  }

  const replacesAnswer = plan.addedOptionId !== null || writes.some((c) => c.selectionId === null)
  if (replacesAnswer) {
    steps.push(...voteUpserts(), ...sel(writes), ...voteDeletes(), ...sel(removals))
  } else {
    steps.push(...voteDeletes(), ...sel(removals), ...voteUpserts(), ...sel(writes))
  }
  if (plan.pass?.op === 'clear') steps.push({ type: 'pass_delete', sectionId, userId, reason: 'clear' })
  return steps
}

// ---------------------------------------------------------------------------
// Applying a plan to cached lists (shared by the optimistic update and tests)
// ---------------------------------------------------------------------------

/** Votes after the plan. `makeVote` builds a row for an upsert (e.g. with the user embedded). */
export function applyPlanToVotes<V extends ModelVote>(votes: ReadonlyArray<V>, plan: AnswerPlan, makeVote: (u: { optionId: string; rank: number | null }) => V): V[] {
  const deleted = new Set(plan.voteDeletes.map((d) => d.id))
  const upsertedOptions = new Set(plan.voteUpserts.map((u) => u.optionId))
  const kept = votes.filter((v) => !deleted.has(v.id) && !(v.user_id === plan.userId && upsertedOptions.has(v.option_id)))
  return [...kept, ...plan.voteUpserts.map(makeVote)]
}

/** Passes after the plan. */
export function applyPlanToPasses(passes: ReadonlyArray<ModelPass>, plan: AnswerPlan): ModelPass[] {
  if (!plan.pass) return [...passes]
  const rest = passes.filter((p) => !(p.section_id === plan.sectionId && p.user_id === plan.userId))
  return plan.pass.op === 'set' ? [...rest, { section_id: plan.sectionId, user_id: plan.userId, kind: plan.pass.kind }] : rest
}

/** Selections after the plan, on a sections list (nested option.selections). */
export function applyPlanToSelections<S extends { id: string; options: Array<{ id: string; selections: Array<{ id: string; user_id: string; metadata: Json | null }> }> }>(
  sections: ReadonlyArray<S>,
  plan: AnswerPlan,
  makeSelection: (c: { optionId: string; metadata: Json }) => S['options'][number]['selections'][number]
): S[] {
  if (plan.selectionChanges.length === 0) return sections as S[]
  return sections.map((section) => {
    if (section.id !== plan.sectionId) return section
    return {
      ...section,
      options: section.options.map((option) => {
        const changes = plan.selectionChanges.filter((c) => c.optionId === option.id)
        if (changes.length === 0) return option
        let selections = option.selections
        for (const c of changes) {
          if (c.metadata === null) {
            selections = selections.filter((s) => s.id !== c.selectionId)
          } else if (c.selectionId) {
            selections = selections.map((s) => (s.id === c.selectionId ? { ...s, metadata: c.metadata } : s))
          } else {
            selections = [...selections.filter((s) => s.user_id !== plan.userId), makeSelection({ optionId: option.id, metadata: c.metadata })]
          }
        }
        return { ...option, selections }
      }),
    }
  })
}
