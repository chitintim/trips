import { daysUntil } from '../../../lib/dates'

/**
 * The extra pre-trip countdown line: "You set off today / tomorrow / Sunday 6 December".
 * Null when there is no own travel date, it is not before the trip start, or it is already past.
 * `today` is a local Date (never derived from toISOString).
 */
export function setOffLine(
  earliestTravelDate: string | null,
  tripStartDate: string,
  today: Date = new Date(),
): string | null {
  if (!earliestTravelDate || earliestTravelDate >= tripStartDate) return null
  const away = daysUntil(earliestTravelDate, today)
  if (away < 0) return null
  if (away === 0) return 'You set off today'
  if (away === 1) return 'You set off tomorrow'
  const when = new Date(earliestTravelDate + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  return `You set off ${when}`
}
