import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface HeaderProps extends HTMLAttributes<HTMLElement> {
  /**
   * Logo or brand element
   */
  logo?: React.ReactNode

  /**
   * Navigation links/items
   */
  nav?: React.ReactNode

  /**
   * Actions (user menu, notifications, etc.)
   */
  actions?: React.ReactNode

  /**
   * Make header sticky
   */
  sticky?: boolean

  /**
   * Slim variant: shorter height, tighter padding. Used for the trip-level
   * header (trip name + stage pill) so more screen stays with content.
   */
  slim?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

export const Header = forwardRef<HTMLElement, HeaderProps>(
  (
    {
      logo,
      nav,
      actions,
      sticky = false,
      slim = false,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles = `
      w-full
      bg-[var(--surface-raised)]/90 backdrop-blur-sm
      border-b border-[var(--border-subtle)]
      ${sticky ? 'sticky top-0 z-sticky' : ''}
    `

    return (
      <header
        ref={ref}
        className={`${baseStyles} ${className}`.trim()}
        {...props}
      >
        <div className="container mx-auto px-4">
          <div className={`flex items-center justify-between ${slim ? 'h-12' : 'h-16'}`}>
            {logo && (
              <div className="flex items-center flex-shrink-0 min-w-0">
                {logo}
              </div>
            )}

            {nav && (
              <nav className="hidden md:flex items-center space-x-8 flex-1 justify-center">
                {nav}
              </nav>
            )}

            {actions && (
              <div className="flex items-center space-x-3 shrink-0">
                {actions}
              </div>
            )}

            {children}
          </div>
        </div>
      </header>
    )
  }
)

Header.displayName = 'Header'

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

export interface HeaderNavItemProps extends HTMLAttributes<HTMLAnchorElement> {
  /**
   * Whether this nav item is active
   */
  isActive?: boolean

  /**
   * Link href
   */
  href?: string
}

export const HeaderNavItem = forwardRef<HTMLAnchorElement, HeaderNavItemProps>(
  ({ isActive = false, href = '#', className = '', children, ...props }, ref) => {
    return (
      <a
        ref={ref}
        href={href}
        className={`
          text-sm font-medium transition-colors
          ${isActive
            ? 'text-accent-600 dark:text-accent-400'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        {children}
      </a>
    )
  }
)

HeaderNavItem.displayName = 'Header.NavItem'

// Export as compound component
export const HeaderWithSubComponents = Object.assign(Header, {
  NavItem: HeaderNavItem,
})
