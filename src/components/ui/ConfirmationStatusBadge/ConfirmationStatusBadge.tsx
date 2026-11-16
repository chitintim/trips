import { HTMLAttributes, forwardRef } from 'react'
import { Badge } from '../Badge'
import { Database } from '../../../types/database.types'
import { rsvpStatusLabel } from '../../../features/people/lib/rsvpLabels'

// ============================================================================
// TYPES
// ============================================================================

type ConfirmationStatus = Database['public']['Enums']['confirmation_status']

export interface ConfirmationStatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /**
   * Confirmation status to display
   */
  status: ConfirmationStatus

  /**
   * Size of the badge
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Show a dot indicator
   */
  dot?: boolean

  /**
   * Show count next to status
   */
  count?: number
}

// ============================================================================
// CONFIGURATION (label text comes from rsvpStatusLabel: one RSVP vocabulary)
// ============================================================================

const STATUS_CONFIG: Record<
  ConfirmationStatus,
  {
    variant: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'neutral'
  }
> = {
  pending: {
    variant: 'warning',
  },
  confirmed: {
    variant: 'success',
  },
  interested: {
    variant: 'info',
  },
  conditional: {
    variant: 'warning',
  },
  waitlist: {
    variant: 'neutral',
  },
  declined: {
    variant: 'error',
  },
  cancelled: {
    variant: 'error',
  },
}

// ============================================================================
// COMPONENT
// ============================================================================

export const ConfirmationStatusBadge = forwardRef<HTMLSpanElement, ConfirmationStatusBadgeProps>(
  ({ status, size = 'md', dot = false, count, className = '', ...props }, ref) => {
    const config = STATUS_CONFIG[status]

    return (
      <Badge
        ref={ref}
        variant={config.variant}
        size={size}
        dot={dot}
        className={className}
        {...props}
      >
        {rsvpStatusLabel(status)}
        {count !== undefined && count > 0 && ` (${count})`}
      </Badge>
    )
  }
)

ConfirmationStatusBadge.displayName = 'ConfirmationStatusBadge'
