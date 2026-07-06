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
    const generatedId = useId()
    const inputId = id || generatedId
    const errorId = `${inputId}-error`
    const helperId = `${inputId}-helper`

    const hasError = !!error
    const hasSuccess = success && !hasError

    const baseStyles = `
      block
      w-full
      rounded-[var(--radius-md)]
      border
      bg-[var(--surface-raised)]
      text-[var(--text-primary)]
      transition-colors duration-150
      placeholder:text-[var(--text-muted)]
      focus:outline-none focus:ring-2 focus:ring-offset-0
      disabled:cursor-not-allowed disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-muted)]
    `

    const sizeStyles = {
      sm: 'h-9 px-3 text-sm',
      md: 'h-11 px-3.5 text-[0.9375rem]',
      lg: 'h-12 px-4 text-lg',
    }

    const addonPaddingStyles = {
      left: { sm: 'pl-9', md: 'pl-10', lg: 'pl-12' },
      right: { sm: 'pr-9', md: 'pr-10', lg: 'pr-12' },
    }

    const stateStyles = hasError
      ? 'border-danger-500 focus:border-danger-500 focus:ring-danger-500'
      : hasSuccess
      ? 'border-success-500 focus:border-success-500 focus:ring-success-500'
      : 'border-[var(--border-default)] focus:border-accent-500 focus:ring-accent-500'

    const inputClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${leftAddon ? addonPaddingStyles.left[size] : ''}
      ${rightAddon ? addonPaddingStyles.right[size] : ''}
      ${stateStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    const addonBaseStyles = 'absolute top-1/2 -translate-y-1/2 flex items-center pointer-events-none text-[var(--text-muted)]'
    const addonSizeStyles = { sm: 'text-sm', md: 'text-base', lg: 'text-lg' }
    const leftAddonPosition = { sm: 'left-3', md: 'left-3', lg: 'left-4' }
    const rightAddonPosition = { sm: 'right-3', md: 'right-3', lg: 'right-4' }

    return (
      <div className={fullWidth ? 'w-full' : 'w-auto'}>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
          >
            {label}
            {required && <span className="text-danger-500 ml-1">*</span>}
          </label>
        )}

        <div className="relative">
          {leftAddon && (
            <div
              className={`${addonBaseStyles} ${addonSizeStyles[size]} ${leftAddonPosition[size]}`}
              aria-hidden="true"
            >
              {leftAddon}
            </div>
          )}

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

          {rightAddon && (
            <div
              className={`${addonBaseStyles} ${addonSizeStyles[size]} ${rightAddonPosition[size]}`}
              aria-hidden="true"
            >
              {rightAddon}
            </div>
          )}
        </div>

        {hasError && (
          <p id={errorId} className="mt-1.5 text-sm text-danger-600" role="alert">
            {error}
          </p>
        )}

        {!hasError && helperText && (
          <p id={helperId} className="mt-1.5 text-sm text-[var(--text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'
