import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../hooks/useAuth'
import { useParticipants } from './useTrip'
import { useSections, useVotes } from './usePlanning'
import { useTimeline } from './useTimeline'
import { useBookings } from './useBookings'
import { useExpenses } from './useExpenses'
import { getFXRate, type Currency } from '../currency'
import { buildYourCost, readEventCost, yourCostHeadline, type YourCostModel } from '../cost/yourCost'
import { inScopeHeadcount } from '../../features/people/lib/inScopePeople'
import { isConfirmationEnabled } from '../tripStatus'
import type { Trip } from '../../types'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Latest cached rates (base per 1 unit) for every non-base currency a price uses. */
function useFxRates(base: string, currencies: string[]): Record<string, number> {
  const key = [...currencies].sort().join(',')
  const { data } = useQuery({
    queryKey: ['fx-latest', base, key],
    enabled: currencies.length > 0,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<Record<string, number>> => {
      const date = todayIso()
      const entries = await Promise.all(
        currencies.map(async (c) => {
          const r = await getFXRate(date, c as Currency, base as Currency).catch(() => null)
          return [c, r?.rate ?? null] as const
        })
      )
      return Object.fromEntries(entries.filter((e): e is readonly [string, number] => e[1] != null))
    },
  })
  return data ?? {}
}

/** Everything the Your cost card needs, from the already-keyed TanStack queries. */
export function useYourCostModel(trip: Trip): { model: YourCostModel | null; isLoading: boolean } {
  const { user } = useAuth()
  const { data: participants = [] } = useParticipants(trip.id)
  const { data: sections, isLoading: sectionsLoading } = useSections(trip.id)
  const { data: votes } = useVotes(trip.id)
  const { data: events } = useTimeline(trip.id)
  const { data: bookings } = useBookings(trip.id)
  const { data: money } = useExpenses(trip.id)

  const base = trip.base_currency || 'GBP'
  const headcount = useMemo(() => inScopeHeadcount(participants, isConfirmationEnabled(trip)), [participants, trip])

  const foreign = useMemo(() => {
    const set = new Set<string>()
    for (const s of sections ?? []) for (const o of s.options) if (o.currency && o.currency !== base) set.add(o.currency)
    // Booking currencies need rates too, or a foreign-currency booking could never join the total.
    for (const b of bookings ?? []) if (b.currency && b.currency !== base) set.add(b.currency)
    for (const e of events ?? []) {
      const c = readEventCost(e.metadata)
      if (c && c.currency !== base) set.add(c.currency)
    }
    if (trip.accommodation_cost_currency && trip.accommodation_cost_currency !== base) set.add(trip.accommodation_cost_currency)
    return [...set]
  }, [sections, events, bookings, base, trip.accommodation_cost_currency])
  const fxRates = useFxRates(base, foreign)

  const organizerName = useMemo(() => {
    const organizer = participants.find((p) => p.role === 'organizer')
    return organizer?.user?.full_name?.split(' ')[0] ?? null
  }, [participants])

  const model = useMemo(() => {
    if (!sections) return null
    return buildYourCost({
      trip: {
        start_date: trip.start_date,
        end_date: trip.end_date,
        status: trip.status,
        base_currency: base,
        estimated_accommodation_cost: trip.estimated_accommodation_cost,
        accommodation_cost_currency: trip.accommodation_cost_currency,
      },
      userId: user?.id ?? null,
      headcount,
      sections,
      votes: votes ?? [],
      events: events ?? [],
      bookings: bookings ?? [],
      expenses: money?.expenses,
      participantUserIds: participants.map((p) => p.user_id),
      fxRates,
      organizerName,
      confirmationEnabled: isConfirmationEnabled(trip),
    })
  }, [sections, votes, events, bookings, money, participants, headcount, fxRates, trip, base, user?.id, organizerName])

  return { model, isLoading: sectionsLoading }
}

/**
 * The "Your cost" headline for places that quote it in a sentence (the RSVP
 * "What 'I'm in' means" step). Null until the plan has real prices: the
 * organizer's rough estimate is quoted separately, under its own name.
 */
export function useYourCostHeadline(trip: Trip): string | null {
  const { model } = useYourCostModel(trip)
  if (!model || model.isEmpty) return null
  if (model.mode === 'estimate' && model.lines.every((l) => l.kind === 'estimate')) return null
  return yourCostHeadline(model)
}
