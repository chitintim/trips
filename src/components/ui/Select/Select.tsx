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
    const generatedId = useId()
    const selectId = id || generatedId
    const errorId = `${selectId}-error`
    const helperId = `${selectId}-helper`

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
      focus:outline-none focus:ring-2 focus:ring-offset-0
      disabled:cursor-not-allowed disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-muted)]
      appearance-none
      bg-no-repeat
      cursor-pointer
    `

    const sizeStyles = {
      sm: 'h-9 px-3 pr-9 text-sm',
      md: 'h-11 px-3.5 pr-10 text-[0.9375rem]',
      lg: 'h-12 px-4 pr-12 text-lg',
    }

    const stateStyles = hasError
      ? 'border-danger-500 focus:border-danger-500 focus:ring-danger-500'
      : hasSuccess
      ? 'border-success-500 focus:border-success-500 focus:ring-success-500'
      : 'border-[var(--border-default)] focus:border-accent-500 focus:ring-accent-500'

    const selectClasses = `
      ${baseStyles}
      ${sizeStyles[size]}
      ${stateStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    const chevronSize = {
      sm: 'w-4 h-4 right-2',
      md: 'w-5 h-5 right-3',
      lg: 'w-6 h-6 right-3',
    }

    return (
      <div className={fullWidth ? 'w-full' : 'w-auto'}>
        {label && (
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
          >
            {label}
            {required && <span className="text-danger-500 ml-1">*</span>}
          </label>
        )}

        <div className="relative">
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
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}

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

          <div
            className={`absolute top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-muted)] ${chevronSize[size]}`}
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

Select.displayName = 'Select'
