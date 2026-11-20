import type { TripStatus } from '../../../lib/tripStatus'
import { tripStageRank } from '../../../lib/tripStage'

/**
 * The ONE rule for "does this person still owe an answer to 'Are you coming?'".
 *
 * Derived, never stored, and it never rewrites anyone's answer. A person who
 * is down as "not sure" (or never replied) is NOT asked again when the trip is
 * full (places = capacity - going - waitlisted) or when replies have closed
 * (the reply-by DATE has passed, or the trip is booked). The to-do engine, the
 * auto-chase job, the People screens and the trip assistant all read this.
 */

export interface RsvpTripInput {
  confirmation_enabled: boolean | null
  confirmation_deadline: string | null
  capacity_limit?: number | null
}
export interface RsvpPersonInput {
  user_id: string
  active?: boolean | null
  confirmation_status?: string | null
  conditional_type?: string | null
  conditional_date?: string | null
  waitlist_offer_expires_at?: string | null
}
export interface TripPlaces {
  capacity: number | null // null = no limit (stored null or <= 0)
  going: number // active confirmed
  waitlisted: number // active waitlist
  free: number | null // capacity - going - waitlisted; null = unlimited; may be negative
}

export type RsvpStandingKind =
  | 'off'
  | 'removed'
  | 'going'
  | 'out'
  | 'waitlist'
  | 'open'
  | 'thinking'
  | 'waiting_condition'
  | 'late'
  | 'no_place'
  | 'closed'

export interface RsvpStanding {
  kind: RsvpStandingKind
  status: string // normalised: null -> 'pending'
  todo: { variant: 'ask' | 'late'; due: string | null } | null // the rsvp:<tripId> to-do
  chaseable: boolean // === (kind === 'open')
  repliesClosed: boolean
  noPlace: boolean
  placeBeingOffered: boolean // noPlace && capacity != null && going < capacity
  blocksBooking: boolean
}
export interface RsvpStandingInput {
  trip: RsvpTripInput
  stage: TripStatus // EFFECTIVE stage, computed by the caller
  person: RsvpPersonInput
  places: TripPlaces // from tripPlaces over the same participants
  today: string // local 'YYYY-MM-DD'
  now: Date // live-offer check only
}

const isActive = (p: RsvpPersonInput) => p.active !== false

export function tripPlaces(trip: RsvpTripInput, participants: ReadonlyArray<RsvpPersonInput>): TripPlaces {
  const limit = trip.capacity_limit
  const capacity = typeof limit === 'number' && limit > 0 ? limit : null
  let going = 0
  let waitlisted = 0
  for (const p of participants) {
    if (!isActive(p)) continue
    if (p.confirmation_status === 'confirmed') going += 1
    else if (p.confirmation_status === 'waitlist') waitlisted += 1
  }
  return { capacity, going, waitlisted, free: capacity === null ? null : capacity - going - waitlisted }
}

/** 'YYYY-MM-DD' of the stored deadline (its first 10 chars), or null. */
export function confirmationDeadlineDate(deadline: string | null | undefined): string | null {
  return deadline ? deadline.slice(0, 10) : null
}

const UNDECIDED = new Set(['pending', 'interested', 'conditional'])

export function rsvpStanding(input: RsvpStandingInput): RsvpStanding {
  const { trip, stage, person, places, today, now } = input
  const rawStatus = person.confirmation_status
  const status = rawStatus ?? 'pending'
  const deadlineDate = confirmationDeadlineDate(trip.confirmation_deadline)
  const deadlinePassed = deadlineDate !== null && deadlineDate < today
  const booked = tripStageRank(stage) >= tripStageRank('booked_awaiting_departure')
  const repliesClosed = deadlinePassed || booked
  const noPlace = places.free !== null && places.free <= 0
  const placeBeingOffered = noPlace && places.capacity !== null && places.going < places.capacity

  const make = (kind: RsvpStandingKind, extra: Partial<RsvpStanding> = {}): RsvpStanding => ({
    kind,
    status,
    todo: null,
    chaseable: kind === 'open',
    repliesClosed,
    noPlace,
    placeBeingOffered,
    blocksBooking: false,
    ...extra,
  })

  if (trip.confirmation_enabled !== true) return make('off')
  if (!isActive(person)) return make('removed')
  if (status === 'confirmed') return make('going')
  if (status === 'declined' || status === 'cancelled') return make('out')
  if (status === 'waitlist') {
    const expires = person.waitlist_offer_expires_at
    const liveOffer = !!expires && new Date(expires).getTime() > now.getTime()
    return make('waitlist', { blocksBooking: liveOffer })
  }
  if (!UNDECIDED.has(status)) return make('out')

  if (noPlace) return make('no_place')
  if (booked) return make('closed')

  let conditionArrived = false
  if (status === 'conditional') {
    const date = person.conditional_date
    conditionArrived = person.conditional_type !== 'users' && !!date && date.slice(0, 10) <= today
    if (!conditionArrived) return make('waiting_condition', { blocksBooking: !repliesClosed })
  }

  // A NULL stored status keeps today's behaviour: no rsvp to-do, no chase.
  if (rawStatus === null || rawStatus === undefined) return make('thinking', { blocksBooking: !repliesClosed })

  if (deadlinePassed) return make('late', { todo: { variant: 'late', due: null } })

  if (status === 'interested' && deadlineDate === null) return make('thinking', { blocksBooking: !repliesClosed })

  return make('open', {
    todo: { variant: 'ask', due: deadlineDate },
    blocksBooking: !repliesClosed,
  })
}

const FULL_DETAIL = "If a place comes free and nobody on the waitlist takes it, we'll ask you here."

export function rsvpStandingLine(s: RsvpStanding, tripName: string): { text: string; detail: string | null } | null {
  const maybe = s.status === 'interested' || s.status === 'conditional'
  switch (s.kind) {
    case 'waitlist':
      if (s.blocksBooking) return null
      return { text: `You're on the waitlist for ${tripName}. If a place is offered to you, you'll see it here.`, detail: null }
    case 'no_place': {
      if (s.placeBeingOffered) {
        return { text: "A place has come free and is being offered to the waitlist first. If nobody takes it, we'll ask you here.", detail: null }
      }
      const full = s.repliesClosed ? `${tripName} is full and replies have closed` : `${tripName} is full`
      const text = maybe
        ? `${full}. You're down as not sure, so there's nothing you need to do.`
        : `${full}, so there's nothing you need to do.`
      return { text, detail: FULL_DETAIL }
    }
    case 'closed':
      return {
        text: maybe ? `Replies for ${tripName} have closed. You're down as not sure.` : `Replies for ${tripName} have closed. You didn't reply.`,
        detail: "If you'd still like to come, say so here.",
      }
    default:
      return null
  }
}

export function rsvpStandingTag(s: RsvpStanding): string | null {
  if (s.kind === 'no_place') return 'Trip full'
  if (s.kind === 'late' || s.kind === 'closed') return 'Replies closed'
  return null
}

const STATUS_WORDS: Record<string, string> = {
  confirmed: 'Going',
  interested: 'Not sure',
  conditional: 'Not sure',
  pending: 'No reply yet',
  waitlist: 'Waitlist',
  declined: 'Not going',
  cancelled: 'Not going',
}

export function rsvpStandingWords(s: RsvpStanding): string {
  const base = STATUS_WORDS[s.status] ?? s.status
  if (s.kind === 'no_place') return `${base} (trip full, no place)`
  if (s.kind === 'late' || s.kind === 'closed') return `${base} (replies closed)`
  return base
}
