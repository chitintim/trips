import { HTMLAttributes, forwardRef, useEffect } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface ToastProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Toast type/variant
   */
  type?: 'success' | 'error' | 'warning' | 'info'

  /**
   * Toast message
   */
  message: string

  /**
   * Optional description/details
   */
  description?: string

  /**
   * Show close button
   */
  showCloseButton?: boolean

  /**
   * Callback when toast is dismissed
   */
  onClose?: () => void

  /**
   * Auto-dismiss after duration (milliseconds)
   */
  duration?: number
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Toast = forwardRef<HTMLDivElement, ToastProps>(
  (
    {
      type = 'info',
      message,
      description,
      showCloseButton = true,
      onClose,
      duration,
      className = '',
      ...props
    },
    ref
  ) => {
    // Auto-dismiss
    useEffect(() => {
      if (duration && onClose) {
        const timer = setTimeout(onClose, duration)
        return () => clearTimeout(timer)
      }
    }, [duration, onClose])

    // Type-based styles
    const typeStyles = {
      success: {
        bg: 'bg-success-50',
        border: 'border-success-500',
        text: 'text-success-800',
        icon: (
          <svg className="w-5 h-5 text-success-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
      },
      error: {
        bg: 'bg-error-50',
        border: 'border-error-500',
        text: 'text-error-800',
        icon: (
          <svg className="w-5 h-5 text-error-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        ),
      },
      warning: {
        bg: 'bg-warning-50',
        border: 'border-warning-500',
        text: 'text-warning-800',
        icon: (
          <svg className="w-5 h-5 text-warning-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        ),
      },
      info: {
        bg: 'bg-info-50',
        border: 'border-info-500',
        text: 'text-info-800',
        icon: (
          <svg className="w-5 h-5 text-info-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
          </svg>
        ),
      },
    }

    const style = typeStyles[type]

    return (
      <div
        ref={ref}
        role="alert"
        className={`
          flex items-start gap-3 p-4 rounded-lg border-l-4 shadow-lg
          ${style.bg} ${style.border} ${style.text}
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        {/* Icon */}
        <div className="flex-shrink-0 mt-0.5">
          {style.icon}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="font-semibold">{message}</p>
          {description && (
            <p className="mt-1 text-sm opacity-90">{description}</p>
          )}
        </div>

        {/* Close button */}
        {showCloseButton && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 p-1 rounded hover:bg-black hover:bg-opacity-10 transition-colors"
            aria-label="Dismiss notification"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    )
  }
)

Toast.displayName = 'Toast'
