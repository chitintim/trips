import { useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { daysUntil, daysUntilClamped } from '../../../lib/dates'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { earliestOwnTravelDate } from '../../people/lib/travelDetails'
import type { Trip } from '../../../types'

/** Pre-trip countdown hero (awaiting-departure Today layout). */
export function CountdownHero({ trip }: { trip: Trip }) {
  const days = daysUntilClamped(trip.start_date)
  const { user } = useAuth()
  const { data: events } = useTimeline(trip.id)
  const setOffLine = useMemo(() => {
    const first = earliestOwnTravelDate(events ?? [], user?.id)
    if (!first || first >= trip.start_date) return null
    const away = daysUntil(first)
    if (away < 0) return null
    if (away === 0) return 'You set off today'
    if (away === 1) return 'You set off tomorrow'
    return `You set off ${new Date(first + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`
  }, [events, user?.id, trip.start_date])

  return (
    <div className="bg-accent-600 text-white px-4 py-8 sm:rounded-[var(--radius-xl)] text-center">
      <p className="text-white/80 text-sm font-medium uppercase tracking-wide">{trip.name}</p>
      {days === 0 ? (
        <p className="text-4xl font-bold mt-2">It starts today! 🎉</p>
      ) : (
        <>
          <p className="text-5xl font-bold mt-2">{days}</p>
          <p className="text-white/90 mt-1">{days === 1 ? 'day to go' : 'days to go'}</p>
        </>
      )}
      <p className="text-white/80 text-sm mt-3">
        {new Date(trip.start_date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} ·{' '}
        {trip.location}
      </p>
      {setOffLine && <p className="text-white/90 text-sm mt-1">{setOffLine}</p>}
    </div>
  )
}
