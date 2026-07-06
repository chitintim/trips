import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Size of the spinner
   */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'

  /**
   * Color variant
   */
  variant?: 'primary' | 'secondary' | 'white' | 'neutral'

  /**
   * Optional label for accessibility
   */
  label?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

const sizeStyles = {
  xs: 'w-3.5 h-3.5 border-2',
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-8 h-8 border-[3px]',
  xl: 'w-12 h-12 border-4',
}

const variantStyles = {
  primary: 'border-accent-200 border-t-accent-600',
  secondary: 'border-warn-200 border-t-warn-600',
  white: 'border-white/30 border-t-white',
  neutral: 'border-[var(--border-subtle)] border-t-[var(--text-secondary)]',
}

export const Spinner = forwardRef<HTMLDivElement, SpinnerProps>(
  (
    {
      size = 'md',
      variant = 'primary',
      label = 'Loading...',
      className = '',
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        role="status"
        aria-label={label}
        className={`inline-flex items-center justify-center ${className}`}
        {...props}
      >
        <span
          className={`inline-block rounded-full animate-spin ${sizeStyles[size]} ${variantStyles[variant]}`}
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
      </div>
    )
  }
)

Spinner.displayName = 'Spinner'
