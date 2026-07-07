import type { Trip } from '../../../types'

/** Pre-trip countdown hero (awaiting-departure Today layout). */
export function CountdownHero({ trip }: { trip: Trip }) {
  const msPerDay = 24 * 60 * 60 * 1000
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(trip.start_date + 'T00:00:00')
  const days = Math.max(0, Math.round((start.getTime() - today.getTime()) / msPerDay))

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
