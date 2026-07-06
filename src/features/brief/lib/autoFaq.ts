/**
 * Auto-generated FAQ (plan §6/§14): accordion built from live trip data —
 * dates, accommodation place+address when present, what's booked, current
 * per-person estimate, "what do I owe" link — so people ask the app
 * before they ask the organizer.
 */
import type { Trip } from '../../../types'
import type { Place } from '../../../lib/queries/usePlaces'
import type { Booking } from '../../../lib/queries/useBookings'
import type { CostBand } from './costBand'
import { formatMoney } from '../../decisions/lib/costImpact'

export interface FaqEntry {
  id: string
  question: string
  answer: string
}

function formatDateRange(startDate: string, endDate: string): string {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'long' }
  return `${start.toLocaleDateString('en-GB', opts)} to ${end.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })}`
}

export function buildAutoFaq(
  trip: Trip,
  places: Place[],
  bookings: Booking[],
  costBand: CostBand | null,
  hasUnpaidBalance: boolean
): FaqEntry[] {
  const entries: FaqEntry[] = []

  entries.push({
    id: 'dates',
    question: 'When is the trip?',
    answer: `${formatDateRange(trip.start_date, trip.end_date)}, in ${trip.location}.`,
  })

  // `places` has no category column yet, so we can't reliably pick "the"
  // accommodation place — fall back to the first place on the trip as a
  // best-effort address/map link until places gain a category (places/maps
  // workstream). The booking title match is the more reliable signal.
  const accommodationPlace = places[0] ?? null
  const accommodationBooking = bookings.find((b) => b.status !== 'cancelled' && /accommodation|hotel|chalet|airbnb|hostel/i.test(b.title))
  if (accommodationBooking || accommodationPlace) {
    const parts: string[] = []
    if (accommodationBooking) parts.push(accommodationBooking.title)
    if (accommodationPlace?.address) parts.push(accommodationPlace.address)
    if (accommodationPlace?.google_maps_link) parts.push(`[Open in Google Maps](${accommodationPlace.google_maps_link})`)
    entries.push({
      id: 'accommodation',
      question: "Where are we staying?",
      answer: parts.length > 0 ? parts.join(' — ') : "Not confirmed yet — check the Decisions tab for options being considered.",
    })
  }

  const bookedItems = bookings.filter((b) => b.status === 'paid' || b.status === 'reserved')
  entries.push({
    id: 'booked',
    question: "What's already booked?",
    answer:
      bookedItems.length > 0
        ? bookedItems.map((b) => `${b.title}${b.vendor ? ` (${b.vendor})` : ''}`).join(', ')
        : 'Nothing has been booked yet — the group is still deciding.',
  })

  if (costBand) {
    entries.push({
      id: 'cost',
      question: 'How much will this cost me?',
      answer:
        costBand.low === costBand.high
          ? `Current estimate: about ${formatMoney(costBand.low, costBand.currency)} per person.`
          : `Current estimate: between ${formatMoney(costBand.low, costBand.currency)} and ${formatMoney(costBand.high, costBand.currency)} per person, depending on which options the group picks.`,
    })
  }

  entries.push({
    id: 'owe',
    question: 'What do I owe so far?',
    answer: hasUnpaidBalance
      ? 'You have outstanding balances — check the Expenses tab for your live total and any unclaimed receipt items.'
      : 'No expenses have been logged yet, or you\'re all settled up. Check the Expenses tab any time for a live total.',
  })

  return entries
}
