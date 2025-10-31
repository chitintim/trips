import { InputHTMLAttributes, forwardRef, useId } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /**
   * Label text displayed above the input
   */
  label?: string

  /**
   * Helper text displayed below the input
   */
  helperText?: string

  /**
   * Error message (also sets error state styling)
   */
  error?: string

  /**
   * Success state styling
   */
  success?: boolean

  /**
   * Size of the input
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Icon or element to display on the left side
   */
  leftAddon?: React.ReactNode

  /**
   * Icon or element to display on the right side
   */
  rightAddon?: React.ReactNode

  /**
   * Make input full width
   */
  fullWidth?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      helperText,
      error,
      success,
      size = 'md',
      leftAddon,
      rightAddon,
      fullWidth = true,
      required,
      disabled,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    // Generate unique IDs for accessibility
    const generatedId = useId()
    const inputId = id || generatedId
    const errorId = `${inputId}-error`
    const helperId = `${inputId}-helper`

    // Determine validation state
    const hasError = !!error
    const hasSuccess = success && !hasError

    // Base input styles
    const baseStyles = `
      block
      w-full
      rounded-lg
      border
      bg-white
      transition-all duration-200
      placeholder:text-neutral-400
      focus:outline-none focus:ring-2 focus:ring-offset-0
      disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500
    `

    // Size styles
    const sizeStyles = {
      sm: 'h-8 px-3 text-sm',
      md: 'h-10 px-4 text-base',
      lg: 'h-12 px-4 text-lg',
    }

    // Padding adjustments for addons
    const addonPaddingStyles = {
      left: {
        sm: 'pl-9',
        md: 'pl-10',
        lg: 'pl-12',
      },
      right: {
        sm: 'pr-9',
        md: 'pr-10',
        lg: 'pr-12',
      },
    }

    // State-based styles
    const stateStyles = hasError
      ? 'border-error-500 focus:border-error-500 focus:ring-error-500'
      : hasSuccess
      ? 'border-success-500 focus:border-success-500 focus:ring-success-500'
      : 'border-neutral-300 focus:border-primary-500 focus:ring-primary-500'

    // Combine all input styles
    const inputClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${leftAddon ? addonPaddingStyles.left[size] : ''}
      ${rightAddon ? addonPaddingStyles.right[size] : ''}
      ${stateStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    // Addon positioning styles
    const addonBaseStyles = 'absolute top-1/2 -translate-y-1/2 flex items-center pointer-events-none text-neutral-400'
    const addonSizeStyles = {
      sm: 'text-sm',
      md: 'text-base',
      lg: 'text-lg',
    }
    const leftAddonPosition = {
      sm: 'left-3',
      md: 'left-3',
      lg: 'left-4',
    }
    const rightAddonPosition = {
      sm: 'right-3',
      md: 'right-3',
      lg: 'right-4',
    }

    return (
      <div className={fullWidth ? 'w-full' : 'w-auto'}>
        {/* Label */}
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-neutral-700 mb-1.5"
          >
            {label}
            {required && <span className="text-error-500 ml-1">*</span>}
          </label>
        )}

        {/* Input container */}
        <div className="relative">
          {/* Left addon */}
          {leftAddon && (
            <div
              className={`${addonBaseStyles} ${addonSizeStyles[size]} ${leftAddonPosition[size]}`}
              aria-hidden="true"
            >
              {leftAddon}
            </div>
          )}

          {/* Input field */}
          <input
            ref={ref}
            id={inputId}
            required={required}
            disabled={disabled}
            className={inputClasses}
            aria-invalid={hasError}
            aria-describedby={
              hasError ? errorId : helperText ? helperId : undefined
            }
            {...props}
          />

          {/* Right addon */}
          {rightAddon && (
            <div
              className={`${addonBaseStyles} ${addonSizeStyles[size]} ${rightAddonPosition[size]}`}
              aria-hidden="true"
            >
              {rightAddon}
            </div>
          )}
        </div>

        {/* Error message */}
        {hasError && (
          <p
            id={errorId}
            className="mt-1.5 text-sm text-error-600"
            role="alert"
          >
            {error}
          </p>
        )}

        {/* Helper text (only show if no error) */}
        {!hasError && helperText && (
          <p
            id={helperId}
            className="mt-1.5 text-sm text-neutral-500"
          >
            {helperText}
          </p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'
