/**
 * Per-question "does this need me?" state + group progress (UX_REDESIGN.md
 * Part 5 "Focused answer flow"): question cards everywhere show a
 * response-state chip ("You're done ✓" / "Needs you") so a glance tells
 * whether the viewer is needed, without opening anything. Works for both
 * decision shapes:
 *   - vote sections: "done" once the viewer has cast at least one vote
 *     among the section's options.
 *   - personal-order sections: "done" once the viewer has at least one
 *     selection (any catalog item ticked) under the section, with the
 *     compact label showing their live order total.
 *
 * Chaser alignment: supabase/functions/auto-chase's section-deadline scan
 * mirrors this shape split — group-vote sections still chase via the
 * 'unvoted_poll' kind (checked via option_votes), while decision_shape
 * 'personal' sections chase via a distinct 'unfilled_order' kind (checked
 * via `selections` rows instead, since personal-order sections never get
 * option_votes at all) with "fill in your picks" wording rather than "vote".
 *
 * Pure (no React/Supabase) so it's independently unit-testable — the Plan
 * tray / entry card / stepper components are thin wrappers over this.
 */
import { formatMoney } from '../../decisions/lib/costImpact'
import { readOptionPricing, readOrderItemMetadata, buildOrderLine, sumOrderLinesByCurrency, type OrderLine } from '../../decisions/lib/decisionShapes'
import { getDecisionShape, type DecisionShape } from '../../decisions/lib/decisionShapes'
import type { OptionVote, OptionWithSelections } from '../../../lib/queries/usePlanning'
import type { Json } from '../../../types/database.types'

export type ResponseState = 'done' | 'needs_you'

export interface QuestionState {
  sectionId: string
  shape: DecisionShape
  state: ResponseState
  /** Compact label for the question row chip, e.g. "You're done ✓", "Needs you", "Your order: £86 ✓", "Fill in your order". */
  label: string
  /** Distinct participants who have responded at all (voted, or placed a non-empty order). */
  respondedCount: number
  totalParticipants: number
}

export interface VoteSectionInput {
  id: string
  metadata: Json | null
  options: Array<{ id: string }>
}

/** Response state for a group-vote (shape 1) question. */
export function computeVoteQuestionState(
  section: VoteSectionInput,
  votes: OptionVote[],
  totalParticipants: number,
  currentUserId: string | null
): QuestionState {
  const optionIds = new Set(section.options.map((o) => o.id))
  const sectionVotes = votes.filter((v) => optionIds.has(v.option_id))
  const voterIds = new Set(sectionVotes.map((v) => v.user_id))
  const myVoted = !!currentUserId && voterIds.has(currentUserId)

  return {
    sectionId: section.id,
    shape: 'vote',
    state: myVoted ? 'done' : 'needs_you',
    label: myVoted ? "You're done ✓" : 'Needs you',
    respondedCount: voterIds.size,
    totalParticipants,
  }
}

export interface PersonalSectionInput {
  id: string
  metadata: Json | null
  options: OptionWithSelections[]
}

/** Response state for a personal-order (shape 2) question. */
export function computePersonalQuestionState(
  section: PersonalSectionInput,
  totalParticipants: number,
  currentUserId: string | null,
  fallbackCurrency: string
): QuestionState {
  const respondedUserIds = new Set<string>()
  const myLines: OrderLine[] = []

  for (const option of section.options) {
    for (const selection of option.selections) {
      respondedUserIds.add(selection.user_id)
      if (currentUserId && selection.user_id === currentUserId) {
        const pricing = readOptionPricing(option.metadata)
        if (pricing) {
          const item = readOrderItemMetadata(selection.metadata)
          myLines.push(buildOrderLine({ id: option.id, title: option.title, currency: option.currency }, pricing, item, fallbackCurrency))
        }
      }
    }
  }

  const hasOrder = myLines.length > 0
  let label = 'Fill in your order'
  if (hasOrder) {
    const totals = sumOrderLinesByCurrency(myLines)
    const [currency, amount] = Object.entries(totals)[0]
    label = `Your order: ${formatMoney(amount, currency)} ✓`
  }

  return {
    sectionId: section.id,
    shape: 'personal',
    state: hasOrder ? 'done' : 'needs_you',
    label,
    respondedCount: respondedUserIds.size,
    totalParticipants,
  }
}

/** Dispatches to the right computation based on the section's decision_shape metadata. */
export function computeQuestionState(
  section: PersonalSectionInput,
  votes: OptionVote[],
  totalParticipants: number,
  currentUserId: string | null,
  fallbackCurrency: string
): QuestionState {
  const shape = getDecisionShape(section.metadata)
  if (shape === 'personal') {
    return computePersonalQuestionState(section, totalParticipants, currentUserId, fallbackCurrency)
  }
  return computeVoteQuestionState(section, votes, totalParticipants, currentUserId)
}

export interface GroupProgress {
  answered: number
  total: number
  /** "4 of 9 answered" */
  label: string
}

export function computeGroupProgress(states: QuestionState[]): GroupProgress {
  const total = states.length
  const answered = states.filter((s) => s.state === 'done').length
  return { answered, total, label: `${answered} of ${total} answered` }
}

/** 30 seconds per open question, rounded to the nearest whole minute (minimum 1 when there's at least one open question). */
export function estimateAnswerMinutes(openCount: number): number {
  if (openCount <= 0) return 0
  return Math.max(1, Math.round(openCount * 0.5))
}

/** "3 things need you · ~2 min" for the Decide lens entry card, or a calm all-done message when nothing's open. */
export function formatEntryCardLabel(openCount: number): string {
  if (openCount <= 0) return "You're all caught up"
  const minutes = estimateAnswerMinutes(openCount)
  return `${openCount} thing${openCount === 1 ? '' : 's'} need${openCount === 1 ? 's' : ''} you · ~${minutes} min`
}
