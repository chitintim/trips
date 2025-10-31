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
    // Generate unique IDs for accessibility
    const generatedId = useId()
    const textareaId = id || generatedId
    const errorId = `${textareaId}-error`
    const helperId = `${textareaId}-helper`

    // Determine validation state
    const hasError = !!error
    const hasSuccess = success && !hasError

    // Calculate character count if showCount is enabled
    const currentLength = value ? String(value).length : 0
    const shouldShowCount = showCount && maxLength

    // Base textarea styles
    const baseStyles = `
      block
      w-full
      rounded-lg
      border
      bg-white
      px-4
      py-3
      transition-all duration-200
      placeholder:text-neutral-400
      focus:outline-none focus:ring-2 focus:ring-offset-0
      disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500
      resize-y
      text-base
    `

    // State-based styles
    const stateStyles = hasError
      ? 'border-error-500 focus:border-error-500 focus:ring-error-500'
      : hasSuccess
      ? 'border-success-500 focus:border-success-500 focus:ring-success-500'
      : 'border-neutral-300 focus:border-primary-500 focus:ring-primary-500'

    // Combine all textarea styles
    const textareaClasses = `
      ${baseStyles}
      ${stateStyles}
      ${className}
    `.trim().replace(/\s+/g, ' ')

    return (
      <div className={fullWidth ? 'w-full' : 'w-auto'}>
        {/* Label */}
        {label && (
          <label
            htmlFor={textareaId}
            className="block text-sm font-medium text-neutral-700 mb-1.5"
          >
            {label}
            {required && <span className="text-error-500 ml-1">*</span>}
          </label>
        )}

        {/* Textarea field */}
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

        {/* Character count */}
        {shouldShowCount && (
          <div className="mt-1.5 text-right">
            <span
              className={`text-sm ${
                maxLength && currentLength > maxLength * 0.9
                  ? 'text-warning-600'
                  : 'text-neutral-500'
              }`}
            >
              {currentLength} / {maxLength}
            </span>
          </div>
        )}

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

        {/* Helper text (only show if no error and no count) */}
        {!hasError && !shouldShowCount && helperText && (
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

TextArea.displayName = 'TextArea'
