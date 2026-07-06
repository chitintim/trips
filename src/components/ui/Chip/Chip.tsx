import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface ChipProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /**
   * Whether the chip is in its selected/active state
   */
  selected?: boolean

  /**
   * Called when the chip body is clicked (e.g. to toggle a filter)
   */
  onClick?: () => void

  /**
   * Show a dismiss (x) button; called when it's clicked
   */
  onDismiss?: () => void

  /**
   * Leading icon/emoji
   */
  icon?: React.ReactNode

  /**
   * Size
   */
  size?: 'sm' | 'md'

  disabled?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(
  (
    {
      selected = false,
      onClick,
      onDismiss,
      icon,
      size = 'md',
      disabled,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const sizeStyles = {
      sm: 'h-7 pl-2.5 pr-2 text-xs gap-1',
      md: 'h-8 pl-3 pr-2.5 text-sm gap-1.5',
    }

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-pressed={selected}
        className={`
          inline-flex items-center rounded-[var(--radius-full)] border font-medium
          transition-colors duration-150
          disabled:opacity-40 disabled:cursor-not-allowed
          ${sizeStyles[size]}
          ${selected
            ? 'bg-accent-600 border-accent-600 text-white'
            : 'bg-[var(--surface-raised)] border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)]'
          }
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        {icon && <span className="shrink-0" aria-hidden="true">{icon}</span>}
        <span>{children}</span>
        {onDismiss && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onDismiss()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onDismiss()
              }
            }}
            aria-label="Remove"
            className={`
              shrink-0 -mr-1 ml-0.5 flex items-center justify-center rounded-full
              ${selected ? 'hover:bg-white/20' : 'hover:bg-[var(--border-subtle)]'}
            `}
          >
            <svg className={size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        )}
      </button>
    )
  }
)

Chip.displayName = 'Chip'
