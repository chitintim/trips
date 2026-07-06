import { TextareaHTMLAttributes, forwardRef, useId } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * Label text displayed above the textarea
   */
  label?: string

  /**
   * Helper text displayed below the textarea
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
   * Make textarea full width
   */
  fullWidth?: boolean

  /**
   * Show character count (requires maxLength prop)
   */
  showCount?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  (
    {
      label,
      helperText,
      error,
      success,
      fullWidth = true,
      showCount = false,
      required,
      disabled,
      className = '',
      id,
      rows = 4,
      maxLength,
      value,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const textareaId = id || generatedId
    const errorId = `${textareaId}-error`
    const helperId = `${textareaId}-helper`

    const hasError = !!error
    const hasSuccess = success && !hasError

    const currentLength = value ? String(value).length : 0
    const shouldShowCount = showCount && maxLength

    const baseStyles = `
      block
      w-full
      rounded-[var(--radius-md)]
      border
      bg-[var(--surface-raised)]
      text-[var(--text-primary)]
      px-3.5
      py-3
      transition-colors duration-150
      placeholder:text-[var(--text-muted)]
      focus:outline-none focus:ring-2 focus:ring-offset-0
      disabled:cursor-not-allowed disabled:bg-[var(--surface-sunken)] disabled:text-[var(--text-muted)]
      resize-y
      text-[0.9375rem]
    `

    const stateStyles = hasError
      ? 'border-danger-500 focus:border-danger-500 focus:ring-danger-500'
      : hasSuccess
      ? 'border-success-500 focus:border-success-500 focus:ring-success-500'
      : 'border-[var(--border-default)] focus:border-accent-500 focus:ring-accent-500'

    const textareaClasses = `
      ${baseStyles}
      ${stateStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    return (
      <div className={fullWidth ? 'w-full' : 'w-auto'}>
        {label && (
          <label
            htmlFor={textareaId}
            className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5"
          >
            {label}
            {required && <span className="text-danger-500 ml-1">*</span>}
          </label>
        )}

        <textarea
          ref={ref}
          id={textareaId}
          required={required}
          disabled={disabled}
          rows={rows}
          maxLength={maxLength}
          value={value}
          className={textareaClasses}
          aria-invalid={hasError}
          aria-describedby={
            hasError ? errorId : helperText ? helperId : undefined
          }
          {...props}
        />

        {shouldShowCount && (
          <div className="mt-1.5 text-right">
            <span
              className={`text-sm ${
                maxLength && currentLength > maxLength * 0.9
                  ? 'text-warn-600'
                  : 'text-[var(--text-muted)]'
              }`}
            >
              {currentLength} / {maxLength}
            </span>
          </div>
        )}

        {hasError && (
          <p id={errorId} className="mt-1.5 text-sm text-danger-600" role="alert">
            {error}
          </p>
        )}

        {!hasError && !shouldShowCount && helperText && (
          <p id={helperId} className="mt-1.5 text-sm text-[var(--text-muted)]">
            {helperText}
          </p>
        )}
      </div>
    )
  }
)

TextArea.displayName = 'TextArea'
