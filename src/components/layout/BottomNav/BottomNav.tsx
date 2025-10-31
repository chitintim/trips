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
          bg-white border-t border-neutral-200
          md:hidden
          z-sticky
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        <div className="flex items-center justify-around h-16 px-2">
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
      py-2 px-3
      rounded-lg
      transition-all duration-200
      text-xs font-medium
      ${isActive
        ? 'text-primary-600 bg-primary-50'
        : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50'
      }
    `

    const content = (
      <>
        {/* Icon container */}
        <div className="relative mb-1">
          <div className="w-6 h-6">
            {icon}
          </div>

          {/* Badge */}
          {badge && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 text-[10px] font-bold text-white bg-error-500 rounded-full">
              {typeof badge === 'number' ? (badge > 99 ? '99+' : badge) : ''}
            </span>
          )}
        </div>

        {/* Label */}
        <span className="leading-none">{label}</span>
      </>
    )

    // Render as link if href provided
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

    // Render as button
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
// EXPORTS
// ============================================================================

export const BottomNav = Object.assign(BottomNavRoot, {
  Item: BottomNavItem,
})
