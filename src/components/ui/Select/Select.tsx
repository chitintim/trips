import { SelectHTMLAttributes, forwardRef, useId } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /**
   * Label text displayed above the select
   */
  label?: string

  /**
   * Helper text displayed below the select
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
   * Size of the select
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Options for the select dropdown
   */
  options: SelectOption[]

  /**
   * Placeholder text shown when no option is selected
   */
  placeholder?: string

  /**
   * Make select full width
   */
  fullWidth?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      helperText,
      error,
      success,
      size = 'md',
      options,
      placeholder,
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
    const selectId = id || generatedId
    const errorId = `${selectId}-error`
    const helperId = `${selectId}-helper`

    // Determine validation state
    const hasError = !!error
    const hasSuccess = success && !hasError

    // Base select styles
    const baseStyles = `
      block
      w-full
      rounded-lg
      border
      bg-white
      transition-all duration-200
      focus:outline-none focus:ring-2 focus:ring-offset-0
      disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500
      appearance-none
      bg-no-repeat
      cursor-pointer
    `

    // Size styles
    const sizeStyles = {
      sm: 'h-8 px-3 pr-9 text-sm',
      md: 'h-10 px-4 pr-10 text-base',
      lg: 'h-12 px-4 pr-12 text-lg',
    }

    // State-based styles
    const stateStyles = hasError
      ? 'border-error-500 focus:border-error-500 focus:ring-error-500'
      : hasSuccess
      ? 'border-success-500 focus:border-success-500 focus:ring-success-500'
      : 'border-neutral-300 focus:border-primary-500 focus:ring-primary-500'

    // Combine all select styles
    const selectClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${stateStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    // Chevron icon styles
    const chevronSize = {
      sm: 'w-4 h-4 right-2',
      md: 'w-5 h-5 right-3',
      lg: 'w-6 h-6 right-3',
    }

    return (
      <div className={fullWidth ? 'w-full' : 'w-auto'}>
        {/* Label */}
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-neutral-700 mb-1.5"
          >
            {label}
            {required && <span className="text-error-500 ml-1">*</span>}
          </label>
        )}

        {/* Select container */}
        <div className="relative">
          {/* Select element */}
          <select
            ref={ref}
            id={selectId}
            required={required}
            disabled={disabled}
            className={selectClasses}
            aria-invalid={hasError}
            aria-describedby={
              hasError ? errorId : helperText ? helperId : undefined
            }
            {...props}
          >
            {/* Placeholder option */}
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}

            {/* Options */}
            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </option>
            ))}
          </select>

          {/* Chevron down icon */}
          <div
            className={`absolute top-1/2 -translate-y-1/2 pointer-events-none text-neutral-400 ${chevronSize[size]}`}
            aria-hidden="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 8.25l-7.5 7.5-7.5-7.5"
              />
            </svg>
          </div>
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

Select.displayName = 'Select'
