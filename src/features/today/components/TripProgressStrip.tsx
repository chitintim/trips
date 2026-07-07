import { dayNofM, tripProgressFraction } from '../../plan/lib/derivedMilestones'
import type { Trip } from '../../../types'

function toDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface TripProgressStripProps {
  trip: Trip
}

/**
 * "Day N of M" + a thin progress bar for the Today hero during
 * trip_ongoing (UX_REDESIGN.md Part 3 "Countdown: ... Day-N-of-M during").
 * Renders nothing outside the trip's date range (defensive — the caller
 * only mounts this during trip_ongoing, but a same-day timezone edge or a
 * stale render shouldn't show a nonsensical fraction).
 */
export function TripProgressStrip({ trip }: TripProgressStripProps) {
  const today = toDateOnly(new Date())
  const dm = dayNofM(today, trip.start_date, trip.end_date)
  const fraction = tripProgressFraction(today, trip.start_date, trip.end_date)
  if (!dm || fraction == null) return null

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-4 py-3 space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-[var(--text-primary)]">
          Day {dm.n} of {dm.m}
        </span>
        <span className="text-[var(--text-muted)]">{trip.name}</span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
        <div
          className="h-full rounded-full bg-accent-500 transition-[width] duration-slow"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </div>
  )
}
