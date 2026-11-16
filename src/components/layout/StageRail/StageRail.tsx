import { HTMLAttributes } from 'react'
import type { Database } from '../../../types/database.types'
import { getTripStatusLabel } from '../../../lib/tripStatus'

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

// Five stage words (UX redesign 2.2). The stored enum still has six values;
// gathering_interest and confirming_participants are one stage, "Who's coming".
const STAGES: { statuses: TripStatus[]; status: TripStatus; label: string }[] = [
  { status: 'gathering_interest', statuses: ['gathering_interest', 'confirming_participants'], label: getTripStatusLabel('gathering_interest') },
  { status: 'booking_details', statuses: ['booking_details'], label: getTripStatusLabel('booking_details') },
  { status: 'booked_awaiting_departure', statuses: ['booked_awaiting_departure'], label: getTripStatusLabel('booked_awaiting_departure') },
  { status: 'trip_ongoing', statuses: ['trip_ongoing'], label: getTripStatusLabel('trip_ongoing') },
  { status: 'trip_completed', statuses: ['trip_completed'], label: getTripStatusLabel('trip_completed') },
]

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Compact progress rail rendering the 5 trip stages, highlighting
 * the current stage. Designed to sit in the trip header (see Header /
 * AppShell). Data-agnostic beyond the trip_status enum.
 */
export function StageRail({ status, compact = false, className = '', ...props }: StageRailProps) {
  const currentIndex = STAGES.findIndex((s) => s.statuses.includes(status))

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
                  {stage.label}
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
