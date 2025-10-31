import { ButtonHTMLAttributes, forwardRef } from 'react'
import { components } from '../../../styles/design-tokens'

// ============================================================================
// TYPES
// ============================================================================

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style variant
   * - primary: Blue background, white text (main actions)
   * - secondary: Orange background, white text (accent actions)
   * - outline: Transparent with border (secondary actions)
   * - ghost: Transparent, no border (subtle actions)
   */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost'

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

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
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
    // Combine disabled state with loading
    const isDisabled = disabled || isLoading

    // Base styles (shared by all variants)
    const baseStyles = `
      inline-flex items-center justify-center
      font-medium
      rounded-lg
      transition-all duration-200
      focus:outline-none focus:ring-2 focus:ring-offset-2
      disabled:cursor-not-allowed disabled:opacity-50
      ${fullWidth ? 'w-full' : ''}
    `

    // Size styles
    const sizeStyles = {
      sm: `text-sm ${components.button.padding.sm} h-8`,
      md: `text-base ${components.button.padding.md} h-10`,
      lg: `text-lg ${components.button.padding.lg} h-12`,
    }

    // Variant styles
    const variantStyles = {
      primary: `
        text-white
        bg-primary-500
        hover:bg-primary-600
        active:bg-primary-700
        focus:ring-primary-500
        shadow-sm
      `,
      secondary: `
        text-white
        bg-secondary-500
        hover:bg-secondary-600
        active:bg-secondary-700
        focus:ring-secondary-500
        shadow-sm
      `,
      outline: `
        text-primary-600
        bg-transparent
        border-2 border-primary-500
        hover:bg-primary-50
        active:bg-primary-100
        focus:ring-primary-500
      `,
      ghost: `
        text-primary-600
        bg-transparent
        hover:bg-primary-50
        active:bg-primary-100
        focus:ring-primary-500
      `,
    }

    // Combine all styles
    const buttonClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${variantStyles[variant]}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    // Icon spacing based on size
    const iconSpacing = {
      sm: 'gap-1.5',
      md: 'gap-2',
      lg: 'gap-2.5',
    }

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={`${buttonClasses} ${iconSpacing[size]}`}
        {...props}
      >
        {/* Loading spinner */}
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

        {/* Left icon */}
        {!isLoading && leftIcon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {leftIcon}
          </span>
        )}

        {/* Button text */}
        {children && <span>{children}</span>}

        {/* Right icon */}
        {rightIcon && (
          <span className="inline-flex shrink-0" aria-hidden="true">
            {rightIcon}
          </span>
        )}
      </button>
    )
  }
)

Button.displayName = 'Button'
