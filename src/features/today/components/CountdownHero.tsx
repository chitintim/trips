import { daysUntilClamped } from '../../../lib/dates'
import type { Trip } from '../../../types'

/** Pre-trip countdown hero (awaiting-departure Today layout). */
export function CountdownHero({ trip }: { trip: Trip }) {
  const days = daysUntilClamped(trip.start_date)

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
    </div>
  )
}
