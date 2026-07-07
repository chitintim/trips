import { HTMLAttributes, ReactNode } from 'react'
import { BottomNav } from '../BottomNav'

// ============================================================================
// TYPES
// ============================================================================

export interface AppShellTabItem {
  key: string
  icon: ReactNode
  label: string
  isActive?: boolean
  onClick?: () => void
  href?: string
  badge?: boolean | number
}

export interface AppShellProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /**
   * Up to 4 primary navigation tabs. Rendered as a bottom tab bar on
   * mobile and — when `sidebarTabs` is omitted — as the left sidebar on
   * >=md screens too.
   */
  tabs: AppShellTabItem[]

  /**
   * Full tab list for the desktop sidebar, when it should show more entries
   * than fit the mobile bottom bar's 4 slots (plan §5: "desktop sidebar
   * shows all tabs"). Falls back to `tabs` when omitted.
   */
  sidebarTabs?: AppShellTabItem[]

  /**
   * Centered raised "+" quick-capture action shown between the tabs on
   * mobile (and as a sidebar button on desktop). Omit to hide it.
   */
  onQuickAdd?: () => void
  quickAddIcon?: ReactNode
  quickAddLabel?: string

  /**
   * Optional header/brand content rendered above the sidebar on desktop
   * and nowhere on mobile (mobile header is handled by the page itself,
   * e.g. TripDetail's own slim Header).
   */
  sidebarHeader?: ReactNode

  /**
   * Page content
   */
  children: ReactNode
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * App shell: fixed bottom tab bar (4 slots + centered FAB) on mobile,
 * switching to a left sidebar at md:. Pages render inside `children`
 * unchanged — this component only supplies the chrome around them.
 */
export function AppShell({
  tabs,
  sidebarTabs,
  onQuickAdd,
  quickAddIcon,
  quickAddLabel = 'Quick add',
  sidebarHeader,
  children,
  className = '',
  ...props
}: AppShellProps) {
  const firstHalf = tabs.slice(0, Math.ceil(tabs.length / 2))
  const secondHalf = tabs.slice(Math.ceil(tabs.length / 2))
  const desktopTabs = sidebarTabs ?? tabs

  return (
    <div className={`min-h-screen bg-[var(--surface-page)] md:flex ${className}`.trim()} {...props}>
      {/* Desktop sidebar — app chrome (UX_REDESIGN.md "Systemic layering" §1):
          explicit z-sticky so nothing in tab content can ever stack above it. */}
      <aside className="hidden md:flex md:flex-col md:w-60 lg:w-64 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--surface-raised)] sticky top-0 z-sticky h-screen">
        {sidebarHeader && (
          <div className="px-5 py-5 border-b border-[var(--border-subtle)]">
            {sidebarHeader}
          </div>
        )}

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {desktopTabs.map((tab) => (
            <SidebarLink key={tab.key} tab={tab} />
          ))}
        </nav>

        {onQuickAdd && (
          <div className="px-3 pb-4">
            <button
              type="button"
              onClick={onQuickAdd}
              className="w-full inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] bg-accent-600 hover:bg-accent-700 text-white font-medium text-sm h-11 transition-colors"
            >
              {quickAddIcon ?? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              )}
              {quickAddLabel}
            </button>
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 pb-tabbar-safe md:pb-0">
        {children}
      </div>

      {/* Mobile bottom tab bar */}
      <BottomNav>
        {firstHalf.map((tab) => (
          <BottomNav.Item
            key={tab.key}
            icon={tab.icon}
            label={tab.label}
            isActive={tab.isActive}
            onClick={tab.onClick}
            href={tab.href}
            badge={tab.badge}
          />
        ))}

        {onQuickAdd && (
          <BottomNav.Fab icon={quickAddIcon} label={quickAddLabel} onClick={onQuickAdd} />
        )}

        {secondHalf.map((tab) => (
          <BottomNav.Item
            key={tab.key}
            icon={tab.icon}
            label={tab.label}
            isActive={tab.isActive}
            onClick={tab.onClick}
            href={tab.href}
            badge={tab.badge}
          />
        ))}
      </BottomNav>
    </div>
  )
}

AppShell.displayName = 'AppShell'

// ============================================================================
// INTERNAL
// ============================================================================

function SidebarLink({ tab }: { tab: AppShellTabItem }) {
  const baseStyles = `
    flex items-center gap-3 w-full px-3 py-2.5 rounded-[var(--radius-md)]
    text-sm font-medium transition-colors duration-150
    ${tab.isActive
      ? 'bg-accent-50 text-accent-700 dark:bg-accent-950 dark:text-accent-300'
      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-primary)]'
    }
  `.trim().replace(/\s+/g, ' ')

  const content = (
    <>
      <span className="w-5 h-5 shrink-0 inline-flex items-center justify-center">{tab.icon}</span>
      <span className="flex-1 text-left truncate">{tab.label}</span>
      {!!tab.badge && (
        <span className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded-full bg-danger-500 text-white text-[11px] font-bold leading-none">
          {typeof tab.badge === 'number' ? (tab.badge > 99 ? '99+' : tab.badge) : ''}
        </span>
      )}
    </>
  )

  if (tab.href) {
    return (
      <a href={tab.href} className={baseStyles} aria-current={tab.isActive ? 'page' : undefined}>
        {content}
      </a>
    )
  }

  return (
    <button type="button" onClick={tab.onClick} className={baseStyles} aria-current={tab.isActive ? 'page' : undefined}>
      {content}
    </button>
  )
}
