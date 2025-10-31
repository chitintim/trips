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
    // Size styles for dots
    const containerSizeStyles = {
      xs: 'gap-0.5',
      sm: 'gap-1',
      md: 'gap-1.5',
      lg: 'gap-2',
      xl: 'gap-2.5',
    }

    const dotSizeStyles = {
      xs: 'w-1 h-1',
      sm: 'w-1.5 h-1.5',
      md: 'w-2 h-2',
      lg: 'w-2.5 h-2.5',
      xl: 'w-3 h-3',
    }

    // Color styles
    const colorStyles = {
      primary: 'bg-primary-600',
      secondary: 'bg-secondary-600',
      white: 'bg-white',
      neutral: 'bg-neutral-600',
    }

    // Snowflake size based on spinner size
    const snowflakeSizeStyles = {
      xs: 'text-xs',
      sm: 'text-sm',
      md: 'text-base',
      lg: 'text-xl',
      xl: 'text-2xl',
    }

    return (
      <div
        ref={ref}
        role="status"
        aria-label={label}
        className={`inline-flex items-center ${containerSizeStyles[size]} ${className}`}
        {...props}
      >
        {/* Snowflake 1 */}
        <span
          className={`${snowflakeSizeStyles[size]} animate-pulse`}
          style={{ animationDelay: '0ms', animationDuration: '1000ms' }}
          aria-hidden="true"
        >
          ❄️
        </span>

        {/* Snowflake 2 */}
        <span
          className={`${snowflakeSizeStyles[size]} animate-pulse`}
          style={{ animationDelay: '200ms', animationDuration: '1000ms' }}
          aria-hidden="true"
        >
          ❄️
        </span>

        {/* Snowflake 3 */}
        <span
          className={`${snowflakeSizeStyles[size]} animate-pulse`}
          style={{ animationDelay: '400ms', animationDuration: '1000ms' }}
          aria-hidden="true"
        >
          ❄️
        </span>

        <span className="sr-only">{label}</span>
      </div>
    )
  }
)

Spinner.displayName = 'Spinner'
