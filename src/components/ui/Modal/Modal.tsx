import { HTMLAttributes, forwardRef, useEffect, useRef } from 'react'
import { components } from '../../../styles/design-tokens'

// ============================================================================
// TYPES
// ============================================================================

export interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Whether the modal is open
   */
  isOpen: boolean

  /**
   * Callback when modal should close
   */
  onClose: () => void

  /**
   * Modal title
   */
  title?: string

  /**
   * Modal size
   */
  size?: 'sm' | 'md' | 'lg' | 'xl'

  /**
   * Show close button (X)
   */
  showCloseButton?: boolean

  /**
   * Close modal when clicking backdrop
   */
  closeOnBackdropClick?: boolean

  /**
   * Close modal when pressing Escape key
   */
  closeOnEscape?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Modal = forwardRef<HTMLDivElement, ModalProps>(
  (
    {
      isOpen,
      onClose,
      title,
      size = 'md',
      showCloseButton = true,
      closeOnBackdropClick = true,
      closeOnEscape = true,
      children,
      className = '',
      ...props
    },
    _ref
  ) => {
    const modalRef = useRef<HTMLDivElement>(null)

    // Handle escape key
    useEffect(() => {
      if (!isOpen || !closeOnEscape) return

      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose()
        }
      }

      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    }, [isOpen, closeOnEscape, onClose])

    // Lock body scroll when modal is open
    useEffect(() => {
      if (isOpen) {
        document.body.style.overflow = 'hidden'
      } else {
        document.body.style.overflow = ''
      }

      return () => {
        document.body.style.overflow = ''
      }
    }, [isOpen])

    // Focus trap - focus modal content when opened
    useEffect(() => {
      if (isOpen && modalRef.current) {
        modalRef.current.focus()
      }
    }, [isOpen])

    // Handle backdrop click
    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdropClick && e.target === e.currentTarget) {
        onClose()
      }
    }

    if (!isOpen) return null

    // Size styles
    const sizeStyles = {
      sm: components.modal.maxWidth.sm,
      md: components.modal.maxWidth.md,
      lg: components.modal.maxWidth.lg,
      xl: components.modal.maxWidth.xl,
    }

    return (
      <div
        className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-black bg-opacity-50 backdrop-blur-sm"
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
      >
        {/* Modal content */}
        <div
          ref={modalRef}
          className={`relative w-full bg-white rounded-lg shadow-2xl max-h-[90vh] flex flex-col ${className}`}
          style={{ maxWidth: sizeStyles[size] }}
          tabIndex={-1}
          {...props}
        >
          {/* Header */}
          {(title || showCloseButton) && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 flex-shrink-0">
              {/* Title */}
              {title && (
                <h2
                  id="modal-title"
                  className="text-xl font-semibold text-neutral-900"
                >
                  {title}
                </h2>
              )}

              {/* Close button */}
              {showCloseButton && (
                <button
                  type="button"
                  onClick={onClose}
                  className="ml-auto p-1 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
                  aria-label="Close modal"
                >
                  <svg
                    className="w-6 h-6"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Body - Scrollable */}
          <div className="px-6 py-6 overflow-y-auto flex-1">
            {children}
          </div>
        </div>
      </div>
    )
  }
)

Modal.displayName = 'Modal'
