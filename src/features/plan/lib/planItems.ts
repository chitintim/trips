/**
 * `PlanItem` composition (UX_REDESIGN.md §2): the Plan surface treats a
 * timeline event, a votable option, and a booking as ONE thing moving
 * through stages of certainty rather than three separate features. This
 * module is the pure (no-React) composition logic that merges:
 *   - trip_timeline_events (via useTimeline)
 *   - planning_sections + options(+selections) (via useSections)
 *   - option_votes (via useVotes)
 *   - bookings (via useBookings)
 * into a single `PlanItem[]`, so the hook (`usePlanItems`) is a thin
 * wrapper and every composition rule can be unit-tested without mounting
 * React or hitting Supabase.
 *
 * Composition rules (plan §2 "under the hood"):
 *  1. Every timeline event becomes a `decided` PlanItem, UNLESS a booking
 *     references it (booking.timeline_event_id), in which case it's
 *     `booked`.
 *  2. Every option under a section whose voting is still open (no winner
 *     resolved onto a timeline event yet) becomes a `proposal` PlanItem —
 *     UNLESS a timeline event already has `source_option_id` pointing at
 *     it, in which case the option is "absorbed" by that event (it must
 *     not render twice: once as a proposal card and once as a decided
 *     card). Absorbed options do not produce their own PlanItem.
 *  3. A proposal's `date` comes from section metadata or option metadata
 *     if present (see OptionMetadata / SectionMetadata below), else null
 *     (renders in the Undecided tray).
 *  4. Bookings never produce their own PlanItem — they enrich whichever
 *     item they reference (via option_id or timeline_event_id) with
 *     `booking` fields. A booking with neither reference is exposed via
 *     `unlinkedBookings` for callers that want to surface it separately
 *     (kept out of PlanItem[] itself, since it isn't a "plan item" in the
 *     idea->proposal->decided->booked sense — it has no stage without a
 *     linked option/event).
 *  5. `idea` stage: an option in a section that isn't run as an active
 *     vote (no voting activity expected / explicitly parked) — modeled
 *     here as options in a section with status `not_started` and no
 *     votes cast yet. This is a light heuristic the UI can refine later;
 *     documented per call so it's easy to adjust.
 */
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'
import type { Booking } from '../../../lib/queries/useBookings'
import type { TimelineEvent } from '../../../types'
import type { Json } from '../../../types/database.types'
import { readOptionMetadata } from '../../decisions/lib/optionMetadata'
import { tallyVotes, getWinner, type VotingMethod } from '../../decisions/lib/voting'
import { getPerPersonCostImpact } from '../../decisions/lib/costImpact'

export type PlanItemStage = 'idea' | 'proposal' | 'decided' | 'booked'

export interface PlanItemVoteSummary {
  votingMethod: VotingMethod
  totalVotes: number
  myVote: { voted: boolean; rank: number | null }
  voteDeadline: string | null
  hideVotesUntilClose: boolean
  quorum: number | null
}

export interface PlanItemCostImpact {
  perPerson: number | null
  currency: string | null
}

export interface PlanItemBookingInfo {
  id: string
  status: string
  vendor: string | null
  confirmationRef: string | null
  cancellationDeadline: string | null
  amount: number | null
  currency: string | null
  expenseId: string | null
}

export interface PlanItem {
  /** Stable identity for the plan item itself (option id or event id — see idKind). */
  id: string
  /** Which underlying row `id` refers to, for lookups/back-navigation. */
  idKind: 'option' | 'event'
  stage: PlanItemStage
  title: string
  description: string | null
  /** YYYY-MM-DD, or null when undated (Undecided tray). */
  date: string | null
  startTime: string | null
  endTime: string | null
  allDay: boolean
  placeId: string | null
  category: string | null

  /** Linked ids, per the schema's existing relational spine. */
  optionId: string | null
  eventId: string | null
  bookingId: string | null
  expenseId: string | null
  sectionId: string | null

  /** Section context — used to group undated proposals in the Undecided tray. */
  sectionTitle: string | null
  sectionType: string | null
  isMatrixSection: boolean

  vote: PlanItemVoteSummary | null
  costImpact: PlanItemCostImpact | null
  booking: PlanItemBookingInfo | null

  /** True once this option has a winner but hasn't been scheduled onto the timeline yet ("put it on the plan"). */
  isUnscheduledWinner: boolean
}

/** Runtime convention for a section carrying a proposed date/time in its metadata (optional, additive). */
export interface SectionDateMetadata {
  proposed_date?: string
  proposed_start_time?: string
  proposed_end_time?: string
}

/** Runtime convention for an option carrying its own proposed date/time in metadata (optional, additive, takes precedence over the section's). */
export interface OptionDateMetadata {
  proposed_date?: string
  proposed_start_time?: string
  proposed_end_time?: string
}

function readSectionDateMetadata(description: string | null, metadata?: Json | null): SectionDateMetadata {
  // Sections don't have a typed metadata column in the current schema, so
  // this reads from a `metadata` field if the caller has one available
  // (forward-compatible); today no caller passes one, so this safely
  // returns {} and undated proposals fall through to the Undecided tray,
  // which matches plan §2's documented default.
  void description
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as SectionDateMetadata
  }
  return {}
}

function readOptionDateMetadata(metadata: Json | null | undefined): OptionDateMetadata {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as OptionDateMetadata
  }
  return {}
}

export interface ComposePlanItemsInput {
  events: TimelineEvent[]
  sections: SectionWithOptions[]
  votes: OptionVote[]
  bookings: Booking[]
  /** For cost-impact display (getPerPersonCostImpact needs a divisor for total_split options). */
  confirmedCount: number
  currentUserId?: string | null
}

export interface ComposePlanItemsResult {
  items: PlanItem[]
  /** Bookings that reference neither an option nor a timeline event — nothing to enrich. */
  unlinkedBookings: Booking[]
}

/**
 * Pure composition: see module doc for the numbered rules. Deterministic
 * given its inputs — no Date.now()/randomness — so it's fully unit
 * testable and safe to call from a `useMemo` in the hook wrapper.
 */
export function composePlanItems(input: ComposePlanItemsInput): ComposePlanItemsResult {
  const { events, sections, votes, bookings, confirmedCount, currentUserId } = input

  const bookingsByOptionId = new Map<string, Booking>()
  const bookingsByEventId = new Map<string, Booking>()
  const unlinkedBookings: Booking[] = []
  for (const booking of bookings) {
    let linked = false
    if (booking.option_id) {
      bookingsByOptionId.set(booking.option_id, booking)
      linked = true
    }
    if (booking.timeline_event_id) {
      bookingsByEventId.set(booking.timeline_event_id, booking)
      linked = true
    }
    if (!linked) unlinkedBookings.push(booking)
  }

  function toBookingInfo(booking: Booking | undefined): PlanItemBookingInfo | null {
    if (!booking) return null
    return {
      id: booking.id,
      status: booking.status,
      vendor: booking.vendor,
      confirmationRef: booking.confirmation_ref,
      cancellationDeadline: booking.cancellation_deadline,
      amount: booking.amount,
      currency: booking.currency,
      expenseId: booking.expense_id,
    }
  }

  // Options absorbed by a timeline event (source_option_id) must not also
  // render as a standalone proposal/decided/idea card (rule 2).
  const absorbedOptionIds = new Set<string>()
  for (const event of events) {
    if (event.source_option_id) absorbedOptionIds.add(event.source_option_id)
  }

  const items: PlanItem[] = []

  // ---- 1. Timeline events: decided, or booked when a booking references them ----
  for (const event of events) {
    const booking = bookingsByEventId.get(event.id)
    items.push({
      id: event.id,
      idKind: 'event',
      stage: booking ? 'booked' : 'decided',
      title: event.title,
      description: event.description,
      date: event.event_date,
      startTime: event.start_time,
      endTime: event.end_time,
      allDay: event.all_day ?? false,
      placeId: event.place_id,
      category: event.category,
      optionId: event.source_option_id,
      eventId: event.id,
      bookingId: booking?.id ?? null,
      expenseId: booking?.expense_id ?? null,
      sectionId: null,
      sectionTitle: null,
      sectionType: null,
      isMatrixSection: false,
      vote: null,
      costImpact: null,
      booking: toBookingInfo(booking),
      isUnscheduledWinner: false,
    })
  }

  // ---- 2-5. Options: proposal / idea, or absorbed into their event ----
  for (const section of sections) {
    const votingMethod = (section.voting_method as VotingMethod) || 'single'
    const optionIds = section.options.map((o) => o.id)
    const sectionVotes = votes.filter((v) => optionIds.includes(v.option_id))
    const tallies = tallyVotes(optionIds, sectionVotes, votingMethod)
    const winner = getWinner(tallies)
    const sectionDateMeta = readSectionDateMetadata(section.description)
    const isMatrixSection = section.options.some((o) => {
      const meta = readOptionMetadata(o.metadata)
      return !!meta.grid_row && !!meta.grid_column
    })

    for (const option of section.options) {
      if (absorbedOptionIds.has(option.id)) continue
      if (option.status === 'cancelled') continue

      const booking = bookingsByOptionId.get(option.id)
      const optionVotes = sectionVotes.filter((v) => v.option_id === option.id)
      const myVote = currentUserId ? optionVotes.find((v) => v.user_id === currentUserId) : undefined
      const optionDateMeta = readOptionDateMetadata(option.metadata)
      const date = optionDateMeta.proposed_date ?? sectionDateMeta.proposed_date ?? null

      const hasAnyVotes = sectionVotes.length > 0
      // Rule 5 heuristic: a section not yet started, with no votes cast on
      // any of its options, reads as a parked "idea" rather than an
      // actively-votable "proposal". Once voting starts (any vote cast) or
      // the section is in_progress/completed, it graduates to `proposal`.
      const isIdea = section.status === 'not_started' && !hasAnyVotes

      const isWinner = !!winner && winner.optionId === option.id && winner.score > 0
      const stage: PlanItemStage = booking ? 'booked' : isIdea ? 'idea' : 'proposal'

      const perPerson = getPerPersonCostImpact({
        price: option.price,
        currency: option.currency,
        priceType: option.price_type,
        confirmedCount,
      })

      items.push({
        id: option.id,
        idKind: 'option',
        stage,
        title: option.title,
        description: option.description,
        date,
        startTime: optionDateMeta.proposed_start_time ?? sectionDateMeta.proposed_start_time ?? null,
        endTime: optionDateMeta.proposed_end_time ?? sectionDateMeta.proposed_end_time ?? null,
        allDay: false,
        placeId: option.place_id,
        category: null,
        optionId: option.id,
        eventId: null,
        bookingId: booking?.id ?? null,
        expenseId: booking?.expense_id ?? null,
        sectionId: section.id,
        sectionTitle: section.title,
        sectionType: section.section_type,
        isMatrixSection: isMatrixSection,
        vote: isIdea
          ? null
          : {
              votingMethod,
              totalVotes: optionVotes.length,
              myVote: { voted: !!myVote, rank: myVote?.rank ?? null },
              voteDeadline: section.vote_deadline,
              hideVotesUntilClose: section.hide_votes_until_close,
              quorum: section.quorum,
            },
        costImpact: perPerson != null ? { perPerson, currency: option.currency } : null,
        booking: toBookingInfo(booking),
        // A winner that hasn't yet produced a timeline event (no event has
        // source_option_id === this option) is ready for "put it on the
        // plan" one-tap scheduling (plan §2 "poll close -> put it on the
        // plan").
        isUnscheduledWinner: isWinner && !absorbedOptionIds.has(option.id),
      })
    }
  }

  return { items, unlinkedBookings }
}

/** Items with a date, grouped by date, each day's items time-ordered (all-day/undated-time first). */
export function groupPlanItemsByDate(items: PlanItem[]): Map<string, PlanItem[]> {
  const byDate = new Map<string, PlanItem[]>()
  for (const item of items) {
    if (!item.date) continue
    const list = byDate.get(item.date) ?? []
    list.push(item)
    byDate.set(item.date, list)
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => {
      const aTime = a.allDay ? '' : a.startTime ?? ''
      const bTime = b.allDay ? '' : b.startTime ?? ''
      if (aTime !== bTime) return aTime < bTime ? -1 : 1
      return a.title.localeCompare(b.title)
    })
  }
  return byDate
}

/** Items with no date at all — the Undecided tray's contents. */
export function getUndatedItems(items: PlanItem[]): PlanItem[] {
  return items.filter((item) => !item.date)
}

/** Undated items grouped by their section (accommodation/flights/etc. category headers in the Undecided tray). Items with no section (e.g. bare ideas) group under a null key. */
export function groupUndatedBySection(items: PlanItem[]): Map<string | null, PlanItem[]> {
  const grouped = new Map<string | null, PlanItem[]>()
  for (const item of getUndatedItems(items)) {
    const key = item.sectionId
    const list = grouped.get(key) ?? []
    list.push(item)
    grouped.set(key, list)
  }
  return grouped
}

/** Only open votables (proposals with a vote summary), sorted by deadline (nulls last) — the Decide lens. */
export function getOpenVotables(items: PlanItem[]): PlanItem[] {
  return items
    .filter((item) => item.stage === 'proposal' && item.vote != null)
    .sort((a, b) => {
      const aDeadline = a.vote!.voteDeadline
      const bDeadline = b.vote!.voteDeadline
      if (aDeadline === bDeadline) return 0
      if (aDeadline == null) return 1
      if (bDeadline == null) return -1
      return aDeadline < bDeadline ? -1 : 1
    })
}
