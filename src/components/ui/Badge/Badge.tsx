import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Visual style variant
   * - primary: Blue (default/general)
   * - secondary: Orange (accent/special)
   * - success: Green (completed/booked)
   * - warning: Yellow (planning/in-progress)
   * - error: Red (cancelled/error)
   * - info: Blue (information)
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
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    // Base styles
    const baseStyles = `
      inline-flex
      items-center
      font-medium
      rounded-full
      border
    `

    // Size styles
    const sizeStyles = {
      sm: 'px-2 py-0.5 text-xs',
      md: 'px-2.5 py-1 text-sm',
      lg: 'px-3 py-1.5 text-base',
    }

    const dotSizeStyles = {
      sm: 'w-1.5 h-1.5 mr-1',
      md: 'w-2 h-2 mr-1.5',
      lg: 'w-2.5 h-2.5 mr-2',
    }

    // Variant styles
    const variantStyles = {
      primary: `
        bg-primary-50
        text-primary-700
        border-primary-200
      `,
      secondary: `
        bg-secondary-50
        text-secondary-700
        border-secondary-200
      `,
      success: `
        bg-success-50
        text-success-700
        border-success-200
      `,
      warning: `
        bg-warning-50
        text-warning-700
        border-warning-200
      `,
      error: `
        bg-error-50
        text-error-700
        border-error-200
      `,
      info: `
        bg-info-50
        text-info-700
        border-info-200
      `,
      neutral: `
        bg-neutral-100
        text-neutral-700
        border-neutral-300
      `,
    }

    // Dot color based on variant
    const dotColorStyles = {
      primary: 'bg-primary-500',
      secondary: 'bg-secondary-500',
      success: 'bg-success-500',
      warning: 'bg-warning-500',
      error: 'bg-error-500',
      info: 'bg-info-500',
      neutral: 'bg-neutral-500',
    }

    // Combine all styles
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
