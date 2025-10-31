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
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles = `
      w-full
      bg-white
      border-b border-neutral-200
      ${sticky ? 'sticky top-0 z-sticky' : ''}
    `

    return (
      <header
        ref={ref}
        className={`${baseStyles} ${className}`.trim()}
        {...props}
      >
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            {logo && (
              <div className="flex items-center flex-shrink-0">
                {logo}
              </div>
            )}

            {/* Navigation (center on desktop, hidden on mobile) */}
            {nav && (
              <nav className="hidden md:flex items-center space-x-8 flex-1 justify-center">
                {nav}
              </nav>
            )}

            {/* Actions (right side) */}
            {actions && (
              <div className="flex items-center space-x-4">
                {actions}
              </div>
            )}

            {/* Custom children content */}
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
            ? 'text-primary-600'
            : 'text-neutral-600 hover:text-neutral-900'
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
