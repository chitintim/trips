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
    // Size styles
    const containerSizeStyles = {
      xs: 'gap-0.5',
      sm: 'gap-1',
      md: 'gap-1.5',
      lg: 'gap-2',
      xl: 'gap-2.5',
    }

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
