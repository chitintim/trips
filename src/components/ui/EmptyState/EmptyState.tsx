import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Icon to display (optional). Accepts an emoji string or any ReactNode
   * (e.g. a lucide-react icon).
   */
  icon?: React.ReactNode

  /**
   * Title text
   */
  title: string

  /**
   * Description text
   */
  description?: string

  /**
   * Action button or element to display
   */
  action?: React.ReactNode

  /**
   * Compact variant for use inside cards / smaller containers
   */
  compact?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      icon,
      title,
      description,
      action,
      compact = false,
      className = '',
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={`flex flex-col items-center justify-center text-center ${compact ? 'py-8 px-4' : 'py-14 px-6'} ${className}`}
        {...props}
      >
        {icon && (
          <div className={`flex items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[var(--text-muted)] ${compact ? 'w-12 h-12 mb-3 text-xl' : 'w-16 h-16 mb-4 text-2xl'}`}>
            {icon}
          </div>
        )}

        <h3 className={`font-semibold text-[var(--text-primary)] ${compact ? 'text-base mb-1' : 'text-lg mb-2'}`}>
          {title}
        </h3>

        {description && (
          <p className="text-sm text-[var(--text-secondary)] max-w-sm mb-6">
            {description}
          </p>
        )}

        {action && (
          <div className="flex items-center gap-3">
            {action}
          </div>
        )}
      </div>
    )
  }
)

EmptyState.displayName = 'EmptyState'
