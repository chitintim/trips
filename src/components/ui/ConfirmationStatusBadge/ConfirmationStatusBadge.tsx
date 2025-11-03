import { HTMLAttributes, forwardRef } from 'react'
import { Badge } from '../Badge'
import { Database } from '../../../types/database.types'

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
// CONFIGURATION
// ============================================================================

const STATUS_CONFIG: Record<
  ConfirmationStatus,
  {
    label: string
    variant: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'neutral'
  }
> = {
  pending: {
    label: 'Pending',
    variant: 'warning',
  },
  confirmed: {
    label: 'Confirmed',
    variant: 'success',
  },
  interested: {
    label: 'Interested',
    variant: 'info',
  },
  conditional: {
    label: 'Conditional',
    variant: 'warning',
  },
  waitlist: {
    label: 'Waitlist',
    variant: 'neutral',
  },
  declined: {
    label: 'Declined',
    variant: 'error',
  },
  cancelled: {
    label: 'Cancelled',
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
        {config.label}
        {count !== undefined && count > 0 && ` (${count})`}
      </Badge>
    )
  }
)

ConfirmationStatusBadge.displayName = 'ConfirmationStatusBadge'
