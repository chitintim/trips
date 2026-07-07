import { ButtonHTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style variant
   * - primary: Accent background, white text (main actions)
   * - secondary: Neutral surface with border (secondary actions)
   * - ghost: Transparent, no border (subtle actions)
   * - danger: Destructive actions
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'

  /**
   * Size of the button
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Show loading spinner and disable interaction
   */
  isLoading?: boolean

  /**
   * Make button full width
   */
  fullWidth?: boolean

  /**
   * Icon to show before the text
   */
  leftIcon?: React.ReactNode

  /**
   * Icon to show after the text
   */
  rightIcon?: React.ReactNode
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Back-compat note: v1 had an `outline` variant. It now renders identically
 * to `secondary` so existing call sites (`variant="outline"`) keep
 * compiling and rendering a sensible bordered button.
 */
function resolveVariant(
  variant: ButtonProps['variant']
): 'primary' | 'secondary' | 'ghost' | 'danger' {
  if (variant === 'outline') return 'secondary'
  return variant ?? 'primary'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant,
      size = 'md',
      isLoading = false,
      fullWidth = false,
      leftIcon,
      rightIcon,
      disabled,
      children,
      className = '',
      ...props
    },
    ref
  ) => {
    const resolvedVariant = resolveVariant(variant)
    const isDisabled = disabled || isLoading

    const baseStyles = `
      inline-flex items-center justify-center
      font-medium
      rounded-[var(--radius-md)]
      transition-colors duration-150
      press-scale
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-raised)]
      disabled:cursor-not-allowed disabled:opacity-50
      select-none
      ${fullWidth ? 'w-full' : ''}
    `

    const sizeStyles = {
      sm: 'text-sm px-3 h-9 gap-1.5',
      md: 'text-[0.9375rem] px-4 h-11 gap-2',
      lg: 'text-base px-5 h-12 gap-2.5',
    }

    const variantStyles = {
      primary: `
        text-white
        bg-accent-600
        hover:bg-accent-700
        active:bg-accent-800
        focus-visible:ring-accent-500
        shadow-sm
      `,
      secondary: `
        text-[var(--text-primary)]
        bg-[var(--surface-raised)]
        border border-[var(--border-default)]
        hover:bg-[var(--surface-sunken)]
        active:bg-neutral-200
        focus-visible:ring-accent-500
      `,
      ghost: `
        text-[var(--text-secondary)]
        bg-transparent
        hover:bg-[var(--surface-sunken)]
        active:bg-neutral-200
        focus-visible:ring-accent-500
      `,
      danger: `
        text-white
        bg-danger-600
        hover:bg-danger-700
        active:bg-danger-800
        focus-visible:ring-danger-500
        shadow-sm
      `,
    }

    const buttonClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${variantStyles[resolvedVariant]}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={buttonClasses}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin -ml-1 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}

        {!isLoading && leftIcon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {leftIcon}
          </span>
        )}

        {children && <span>{children}</span>}

        {!isLoading && rightIcon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {rightIcon}
          </span>
        )}
      </button>
    )
  }
)

Button.displayName = 'Button'
