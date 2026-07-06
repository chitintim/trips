import { HTMLAttributes, createContext, useContext, forwardRef } from 'react'

// ============================================================================
// CONTEXT
// ============================================================================

interface TabsContextValue {
  value: string
  onChange: (value: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('Tabs.Tab / Tabs.List must be used within <Tabs>')
  return ctx
}

// ============================================================================
// TYPES
// ============================================================================

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /**
   * Currently active tab value
   */
  value: string

  /**
   * Called when the active tab changes
   */
  onChange: (value: string) => void
}

export interface TabsListProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Allow horizontal scroll + hide scrollbar (for many tabs on mobile)
   */
  scrollable?: boolean
}

export interface TabProps extends Omit<HTMLAttributes<HTMLButtonElement>, 'value'> {
  value: string
  disabled?: boolean
}

// ============================================================================
// COMPONENTS
// ============================================================================

const TabsRoot = forwardRef<HTMLDivElement, TabsProps>(
  ({ value, onChange, className = '', children, ...props }, ref) => {
    return (
      <TabsContext.Provider value={{ value, onChange }}>
        <div ref={ref} className={className} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    )
  }
)
TabsRoot.displayName = 'Tabs'

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ scrollable = true, className = '', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="tablist"
        className={`
          flex items-center gap-1 border-b border-[var(--border-subtle)]
          ${scrollable ? 'overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden' : ''}
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        {children}
      </div>
    )
  }
)
TabsList.displayName = 'Tabs.List'

const Tab = forwardRef<HTMLButtonElement, TabProps>(
  ({ value, disabled, className = '', children, ...props }, ref) => {
    const { value: activeValue, onChange } = useTabsContext()
    const isActive = activeValue === value

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        aria-selected={isActive}
        disabled={disabled}
        onClick={() => onChange(value)}
        className={`
          relative shrink-0 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap
          transition-colors duration-150
          disabled:opacity-40 disabled:cursor-not-allowed
          ${isActive
            ? 'text-accent-700 dark:text-accent-300'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        {children}
        <span
          className={`absolute left-2 right-2 -bottom-px h-0.5 rounded-full transition-colors duration-150 ${
            isActive ? 'bg-accent-600' : 'bg-transparent'
          }`}
          aria-hidden="true"
        />
      </button>
    )
  }
)
Tab.displayName = 'Tabs.Tab'

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  value: string
}

function TabPanel({ value, className = '', children, ...props }: TabPanelProps) {
  const { value: activeValue } = useTabsContext()
  if (activeValue !== value) return null

  return (
    <div role="tabpanel" className={className} {...props}>
      {children}
    </div>
  )
}
TabPanel.displayName = 'Tabs.Panel'

// ============================================================================
// EXPORTS
// ============================================================================

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Tab,
  Panel: TabPanel,
})
