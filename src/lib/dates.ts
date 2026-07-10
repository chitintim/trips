/**
 * Shared "days until a date" math, extracted from three near-identical
 * implementations (CountdownHero, TripCard, TripDetail's getCountdown) that
 * had each hand-rolled their own local-midnight diff with slightly
 * different rounding. All three now compute off local midnight so the
 * count doesn't flicker between values within the same day.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Whole days from `from` (default: now) until `dateStr` (a `YYYY-MM-DD`
 * date, interpreted at local midnight). Negative when `dateStr` is in the
 * past. Never NaN for a well-formed date string.
 */
export function daysUntil(dateStr: string, from: Date = new Date()): number {
  const target = new Date(dateStr + 'T00:00:00')
  const today = new Date(from)
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / MS_PER_DAY)
}

/** Non-negative variant (clamped to 0) for "days to go" style countdowns. */
export function daysUntilClamped(dateStr: string, from: Date = new Date()): number {
  return Math.max(0, daysUntil(dateStr, from))
}
