import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Visual style variant
   * - primary: Accent (default/general)
   * - secondary: Warm amber (accent/special)
   * - success: Green (completed/booked)
   * - warning: Amber (planning/in-progress)
   * - error: Red (cancelled/error)
   * - info: Accent (information)
   * - neutral: Gray (inactive/neutral)
   */
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'neutral'

  /**
   * Size of the badge
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Add a dot indicator before the text
   */
  dot?: boolean

  /**
   * Allow the badge text to wrap onto multiple lines instead of the default
   * single-line nowrap. Use for badges carrying free-form labels (e.g. the
   * organizer blockers board's per-person loop chips, which quote section/
   * expense titles) so long content wraps inside its card on narrow
   * viewports rather than spilling out of it.
   */
  wrap?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      dot = false,
      wrap = false,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles = `
      inline-flex
      items-center
      font-medium
      rounded-[var(--radius-full)]
      border
      ${wrap ? 'whitespace-normal break-words text-left max-w-full' : 'whitespace-nowrap'}
    `

    const sizeStyles = {
      sm: 'px-2 py-0.5 text-xs',
      md: 'px-2.5 py-1 text-xs',
      lg: 'px-3 py-1.5 text-sm',
    }

    const dotSizeStyles = {
      sm: 'w-1.5 h-1.5 mr-1',
      md: 'w-1.5 h-1.5 mr-1.5',
      lg: 'w-2 h-2 mr-2',
    }

    const variantStyles = {
      primary: 'bg-accent-50 text-accent-700 border-accent-200 dark:bg-accent-950 dark:text-accent-300 dark:border-accent-800',
      secondary: 'bg-warn-50 text-warn-700 border-warn-200 dark:bg-warn-900 dark:text-warn-300 dark:border-warn-800',
      success: 'bg-success-50 text-success-700 border-success-200 dark:bg-success-900 dark:text-success-300 dark:border-success-800',
      warning: 'bg-warn-50 text-warn-700 border-warn-200 dark:bg-warn-900 dark:text-warn-300 dark:border-warn-800',
      error: 'bg-danger-50 text-danger-700 border-danger-200 dark:bg-danger-900 dark:text-danger-300 dark:border-danger-800',
      info: 'bg-accent-50 text-accent-700 border-accent-200 dark:bg-accent-950 dark:text-accent-300 dark:border-accent-800',
      neutral: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)] border-[var(--border-subtle)]',
    }

    const dotColorStyles = {
      primary: 'bg-accent-500',
      secondary: 'bg-warn-500',
      success: 'bg-success-500',
      warning: 'bg-warn-500',
      error: 'bg-danger-500',
      info: 'bg-accent-500',
      neutral: 'bg-neutral-400',
    }

    const badgeClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${variantStyles[variant]}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    return (
      <span ref={ref} className={badgeClasses} {...props}>
        {dot && (
          <span
            className={`rounded-full ${dotSizeStyles[size]} ${dotColorStyles[variant]}`}
            aria-hidden="true"
          />
        )}
        {children}
      </span>
    )
  }
)

Badge.displayName = 'Badge'
