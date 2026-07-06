import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface BottomNavProps extends HTMLAttributes<HTMLElement> {
  /**
   * Nav items
   */
  children: React.ReactNode
}

export interface BottomNavItemProps extends HTMLAttributes<HTMLButtonElement> {
  /**
   * Icon element
   */
  icon: React.ReactNode

  /**
   * Label text
   */
  label: string

  /**
   * Whether this item is active
   */
  isActive?: boolean

  /**
   * Click handler
   */
  onClick?: () => void

  /**
   * Link href (if using as link)
   */
  href?: string

  /**
   * Show notification badge
   */
  badge?: boolean | number
}

export interface BottomNavFabProps extends HTMLAttributes<HTMLButtonElement> {
  /**
   * Icon element (defaults to a "+" glyph if omitted)
   */
  icon?: React.ReactNode

  /**
   * Accessible label
   */
  label?: string

  onClick?: () => void
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const BottomNavRoot = forwardRef<HTMLElement, BottomNavProps>(
  ({ children, className = '', ...props }, ref) => {
    return (
      <nav
        ref={ref}
        className={`
          fixed bottom-0 left-0 right-0
          bg-[var(--surface-raised)]/95 backdrop-blur-sm border-t border-[var(--border-subtle)]
          md:hidden
          z-sticky
          pb-safe
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        <div className="relative flex items-stretch justify-around h-16 px-1">
          {children}
        </div>
      </nav>
    )
  }
)

BottomNavRoot.displayName = 'BottomNav'

// ============================================================================
// ITEM COMPONENT
// ============================================================================

const BottomNavItem = forwardRef<HTMLButtonElement, BottomNavItemProps>(
  (
    {
      icon,
      label,
      isActive = false,
      onClick,
      href,
      badge = false,
      className = '',
      ...props
    },
    ref
  ) => {
    const baseStyles = `
      relative
      flex flex-col items-center justify-center
      flex-1
      py-2 px-2
      rounded-[var(--radius-sm)]
      transition-colors duration-150
      text-[11px] font-medium
      ${isActive
        ? 'text-accent-600 dark:text-accent-400'
        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
      }
    `

    const content = (
      <>
        <div className="relative mb-0.5">
          <div className="w-6 h-6">
            {icon}
          </div>

          {badge && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 text-[10px] font-bold text-white bg-danger-500 rounded-full">
              {typeof badge === 'number' ? (badge > 99 ? '99+' : badge) : ''}
            </span>
          )}
        </div>

        <span className="leading-none">{label}</span>
      </>
    )

    if (href) {
      return (
        <a
          href={href}
          className={`${baseStyles} ${className}`.trim()}
          aria-current={isActive ? 'page' : undefined}
        >
          {content}
        </a>
      )
    }

    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        className={`${baseStyles} ${className}`.trim()}
        aria-current={isActive ? 'page' : undefined}
        {...props}
      >
        {content}
      </button>
    )
  }
)

BottomNavItem.displayName = 'BottomNav.Item'

// ============================================================================
// FAB SLOT (centered, raised "+" quick-capture button)
// ============================================================================

const BottomNavFab = forwardRef<HTMLButtonElement, BottomNavFabProps>(
  ({ icon, label = 'Add', onClick, className = '', ...props }, ref) => {
    return (
      <div className="relative flex-1 flex items-center justify-center">
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-label={label}
          className={`
            absolute -top-5
            inline-flex items-center justify-center
            w-14 h-14 rounded-full
            bg-accent-600 text-white
            shadow-lg shadow-accent-600/30
            hover:bg-accent-700
            active:scale-95
            transition-all duration-150
            ring-4 ring-[var(--surface-raised)]
            ${className}
          `.trim().replace(/\s+/g, ' ')}
          {...props}
        >
          {icon ?? (
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          )}
        </button>
      </div>
    )
  }
)

BottomNavFab.displayName = 'BottomNav.Fab'

// ============================================================================
// EXPORTS
// ============================================================================

export const BottomNav = Object.assign(BottomNavRoot, {
  Item: BottomNavItem,
  Fab: BottomNavFab,
})
