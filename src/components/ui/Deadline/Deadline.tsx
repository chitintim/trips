import { HTMLAttributes, forwardRef } from 'react'
import { deadlineUrgency } from '../../../lib/dates'

// ============================================================================
// TYPES
// ============================================================================

export interface DeadlineProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /**
   * ISO date or datetime string this deadline falls on/at.
   */
  date: string

  /**
   * What kind of deadline this is, used only to pick the "passed" label
   * (e.g. "Vote closed" vs "Deadline passed"). Purely cosmetic.
   */
  kind?: 'deadline' | 'vote' | 'offer' | 'cancellation'

  /**
   * Compact: icon + short text only (e.g. for inline chips in dense lists).
   * Non-compact adds a touch more padding/weight for header use.
   */
  compact?: boolean

  /**
   * Size
   */
  size?: 'sm' | 'md'
}

// ============================================================================
// HELPERS
// ============================================================================

const PASSED_LABEL: Record<NonNullable<DeadlineProps['kind']>, string> = {
  deadline: 'Deadline passed',
  vote: 'Voting closed',
  offer: 'Offer expired',
  cancellation: 'Window closed',
}

/**
 * Urgency bucket driving color: passed (gray), danger (≤2 days), warn
 * (≤7 days), neutral otherwise. Thresholds come from the shared
 * deadlineUrgency helper in lib/dates so every countdown chip (this
 * component, action-row badges, Today chips) agrees on when things turn
 * amber/red.
 */
export function getDeadlineUrgency(date: string, now: number = Date.now()): 'passed' | 'urgent' | 'soon' | 'normal' {
  const target = new Date(date).getTime()
  const diffMs = target - now
  if (diffMs <= 0) return 'passed'
  const daysLeft = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  const urgency = deadlineUrgency(daysLeft)
  return urgency === 'overdue' ? 'passed' : urgency
}

/** Human "3d left" / "6h left" / "Ended 2d ago" style label. */
export function formatDeadlineLabel(date: string, kind: DeadlineProps['kind'] = 'deadline', now: number = Date.now()): string {
  const target = new Date(date).getTime()
  const diffMs = target - now
  const absMs = Math.abs(diffMs)
  const days = Math.floor(absMs / (24 * 60 * 60 * 1000))
  const hours = Math.floor(absMs / (60 * 60 * 1000))
  const minutes = Math.floor(absMs / (60 * 1000))

  if (diffMs <= 0) {
    if (days >= 1) return `${PASSED_LABEL[kind]} · ${days}d ago`
    return PASSED_LABEL[kind]
  }

  if (days >= 1) return `${days}d left`
  if (hours >= 1) return `${hours}h left`
  return `${Math.max(minutes, 1)}m left`
}

// ============================================================================
// COMPONENT
// ============================================================================

const urgencyStyles: Record<ReturnType<typeof getDeadlineUrgency>, string> = {
  passed: 'bg-neutral-100 text-neutral-500 border-neutral-200',
  urgent: 'bg-danger-50 text-danger-700 border-danger-200',
  soon: 'bg-warn-50 text-warn-700 border-warn-200',
  normal: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)] border-[var(--border-default)]',
}

const urgencyIcon: Record<ReturnType<typeof getDeadlineUrgency>, string> = {
  passed: '⏹️',
  urgent: '⏰',
  soon: '⏳',
  normal: '📅',
}

/**
 * Reusable deadline/countdown chip: color-coded by urgency (danger inside
 * 24h or passed, warn inside 3 days, neutral otherwise). Used for
 * confirmation_deadline, planning_sections.vote_deadline, waitlist offer
 * expiry, and booking cancellation_deadline — anywhere a countdown was
 * previously computed ad-hoc inline.
 */
export const Deadline = forwardRef<HTMLSpanElement, DeadlineProps>(
  ({ date, kind = 'deadline', compact = false, size = 'md', className = '', ...props }, ref) => {
    const urgency = getDeadlineUrgency(date)
    const label = formatDeadlineLabel(date, kind)
    const sizeStyles = size === 'sm' ? 'text-xs px-2 py-0.5 gap-1' : 'text-sm px-2.5 py-1 gap-1.5'

    return (
      <span
        ref={ref}
        className={`inline-flex items-center rounded-[var(--radius-full)] border font-medium whitespace-nowrap ${sizeStyles} ${urgencyStyles[urgency]} ${className}`.trim()}
        {...props}
      >
        <span aria-hidden="true">{urgencyIcon[urgency]}</span>
        <span>{compact ? label : label}</span>
      </span>
    )
  }
)

Deadline.displayName = 'Deadline'
