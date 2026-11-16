import { useCallback } from 'react'
import { useVotes, type OptionWithSelections, type SectionWithOptions } from '../../../lib/queries/usePlanning'
import { useBookings } from '../../../lib/queries/useBookings'
import { computeOptionPrice, type OptionPrice } from '../../../lib/cost/optionPrice'
import { meaningfulPrice } from './optionPricingForm'
import { isDecidedOption } from './resolveDecision'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import type { InScopeHeadcount } from '../../people/lib/inScopePeople'
import type { Trip } from '../../../types'

/**
 * Prices an option of `section` through `computeOptionPrice`, with the
 * lifecycle context the caches already hold: the option is "decided" when it
 * won a closed question, "booked" when a live booking with an amount exists.
 * `headcount` is the in-scope headcount the caller already computed.
 */
export function useOptionPrice(trip: Trip, section: SectionWithOptions, headcount: InScopeHeadcount, closed?: boolean) {
  const { data: votes } = useVotes(trip.id)
  const { data: bookings } = useBookings(trip.id)
  return useCallback(
    (option: OptionWithSelections): OptionPrice | null => {
      const decidedSection = closed && section.status !== 'completed' ? { ...section, status: 'completed' as const } : section
      const decided = isDecidedOption(decidedSection, votes ?? [], option.id)
      const booking = (bookings ?? []).find((b) => b.option_id === option.id && b.status !== 'cancelled' && b.amount != null)
      return meaningfulPrice(computeOptionPrice(option, trip, headcount, {
        decided,
        booking: booking ? { amount: booking.amount, currency: booking.currency, status: booking.status } : null,
        // Legacy flag: live `bookings` is empty, every Booked card is options.status = 'booked'.
        booked: option.status === 'booked',
        confirmationEnabled: isConfirmationEnabled(trip),
      }))
    },
    [trip, section, headcount, closed, votes, bookings]
  )
}
