import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Icon to display (optional)
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
      className = '',
      ...props
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={`flex flex-col items-center justify-center py-12 px-6 text-center ${className}`}
        {...props}
      >
        {/* Icon */}
        {icon && (
          <div className="flex items-center justify-center w-16 h-16 mb-4 rounded-full bg-neutral-100 text-neutral-400">
            {icon}
          </div>
        )}

        {/* Title */}
        <h3 className="text-lg font-semibold text-neutral-900 mb-2">
          {title}
        </h3>

        {/* Description */}
        {description && (
          <p className="text-sm text-neutral-500 max-w-sm mb-6">
            {description}
          </p>
        )}

        {/* Action */}
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
