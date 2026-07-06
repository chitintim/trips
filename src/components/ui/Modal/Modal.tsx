import { HTMLAttributes, forwardRef, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

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
   * Modal size (max-width at >=md breakpoint; full-width sheet on mobile
   * regardless of size)
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

// Desktop (md:) max-width per size. Mobile is always full-width (bottom sheet).
const sizeMaxWidthClass = {
  sm: 'md:max-w-md',
  md: 'md:max-w-lg',
  lg: 'md:max-w-2xl',
  xl: 'md:max-w-4xl',
}

/**
 * Modal renders as a full-width bottom sheet on mobile (slides up, rounded
 * top corners, drag-handle affordance) and a centered dialog on >=md
 * screens. Same prop API as v1's Modal so every existing call site keeps
 * working unchanged.
 */
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
    forwardedRef
  ) => {
    const modalRef = useRef<HTMLDivElement | null>(null)
    const previouslyFocused = useRef<HTMLElement | null>(null)

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

    // Focus trap: focus modal content on open, restore focus on close
    useEffect(() => {
      if (isOpen) {
        previouslyFocused.current = document.activeElement as HTMLElement
        modalRef.current?.focus()
      } else if (previouslyFocused.current) {
        previouslyFocused.current.focus()
        previouslyFocused.current = null
      }
    }, [isOpen])

    // Basic focus trap: keep Tab cycling within the dialog
    useEffect(() => {
      if (!isOpen) return

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'Tab' || !modalRef.current) return

        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return

        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }

      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }, [isOpen])

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdropClick && e.target === e.currentTarget) {
        onClose()
      }
    }

    if (!isOpen) return null

    const content = (
      <div
        className="fixed inset-0 z-modal overflow-y-auto bg-[var(--surface-overlay)] backdrop-blur-[2px] animate-[fable-fade-in_0.15s_ease-out]"
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
      >
        {/* Mobile: bottom sheet, full width, anchored to bottom */}
        {/* Desktop (md:): centered dialog */}
        <div className="flex min-h-full items-end justify-center md:items-center md:p-4">
          <div
            ref={(node) => {
              modalRef.current = node
              if (typeof forwardedRef === 'function') {
                forwardedRef(node)
              } else if (forwardedRef) {
                (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node
              }
            }}
            className={`
              relative w-full bg-[var(--surface-raised)] text-[var(--text-primary)]
              rounded-t-[var(--radius-xl)] md:rounded-[var(--radius-lg)]
              shadow-xl
              max-h-[92vh] md:max-h-[90vh]
              flex flex-col
              pb-safe
              ${sizeMaxWidthClass[size]}
              animate-[fable-sheet-up_0.2s_ease-out] md:animate-[fable-scale-in_0.15s_ease-out]
              ${className}
            `.trim().replace(/\s+/g, ' ')}
            tabIndex={-1}
            {...props}
          >
            <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-[var(--border-default)] md:hidden" aria-hidden="true" />

            {(title || showCloseButton) && (
              <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-[var(--border-subtle)] shrink-0">
                {title && (
                  <h2
                    id="modal-title"
                    className="text-lg font-semibold text-[var(--text-primary)]"
                  >
                    {title}
                  </h2>
                )}

                {showCloseButton && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="ml-auto p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-sunken)] transition-colors"
                    aria-label="Close modal"
                  >
                    <svg
                      className="w-5 h-5"
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

            <div className="px-5 sm:px-6 py-5 sm:py-6 overflow-y-auto flex-1">
              {children}
            </div>
          </div>
        </div>
      </div>
    )

    return createPortal(content, document.body)
  }
)

Modal.displayName = 'Modal'
