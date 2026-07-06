import { HTMLAttributes } from 'react'
import type { Database } from '../../../types/database.types'

type TripStatus = Database['public']['Enums']['trip_status']

// ============================================================================
// TYPES
// ============================================================================

export interface StageRailProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Current trip status
   */
  status: TripStatus

  /**
   * Compact mode: icons/dots only, no labels (good for tight header space)
   */
  compact?: boolean
}

// ============================================================================
// CONFIG
// ============================================================================

const STAGES: { status: TripStatus; label: string; shortLabel: string }[] = [
  { status: 'gathering_interest', label: 'Gather interest', shortLabel: 'Interest' },
  { status: 'confirming_participants', label: 'Confirm participants', shortLabel: 'Confirm' },
  { status: 'booking_details', label: 'Decide & book', shortLabel: 'Book' },
  { status: 'booked_awaiting_departure', label: 'Awaiting departure', shortLabel: 'Departure' },
  { status: 'trip_ongoing', label: 'Trip ongoing', shortLabel: 'Ongoing' },
  { status: 'trip_completed', label: 'Completed', shortLabel: 'Done' },
]

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Compact progress rail rendering the 6 trip lifecycle stages, highlighting
 * the current stage. Designed to sit in the trip header (see Header /
 * AppShell). Data-agnostic beyond the trip_status enum.
 */
export function StageRail({ status, compact = false, className = '', ...props }: StageRailProps) {
  const currentIndex = STAGES.findIndex((s) => s.status === status)

  return (
    <div
      className={`flex items-center gap-0.5 ${className}`}
      role="list"
      aria-label="Trip stage"
      {...props}
    >
      {STAGES.map((stage, i) => {
        const isDone = currentIndex >= 0 && i < currentIndex
        const isCurrent = i === currentIndex
        const isUpcoming = currentIndex >= 0 && i > currentIndex

        return (
          <div key={stage.status} role="listitem" className="flex items-center gap-0.5 min-w-0">
            <div
              className="flex flex-col items-center gap-1 shrink-0"
              title={stage.label}
            >
              <span
                className={`
                  rounded-full shrink-0 transition-colors duration-200
                  ${compact ? 'w-1.5 h-1.5' : 'w-2 h-2'}
                  ${isDone ? 'bg-accent-500' : ''}
                  ${isCurrent ? 'bg-accent-600 ring-2 ring-accent-200 dark:ring-accent-800' : ''}
                  ${isUpcoming ? 'bg-[var(--border-default)]' : ''}
                `.trim().replace(/\s+/g, ' ')}
                aria-current={isCurrent ? 'step' : undefined}
              />
              {!compact && (
                <span
                  className={`text-[10px] font-medium leading-none whitespace-nowrap hidden sm:block ${
                    isCurrent ? 'text-accent-700 dark:text-accent-300' : 'text-[var(--text-muted)]'
                  }`}
                >
                  {stage.shortLabel}
                </span>
              )}
            </div>
            {i < STAGES.length - 1 && (
              <span
                className={`h-px w-3 sm:w-5 shrink-0 ${isDone ? 'bg-accent-500' : 'bg-[var(--border-subtle)]'}`}
                aria-hidden="true"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

StageRail.displayName = 'StageRail'
