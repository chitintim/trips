import { HTMLAttributes } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface NeedsAttentionItem {
  /**
   * Icon/emoji shown on the chip (any ReactNode, e.g. lucide icon or emoji)
   */
  icon: React.ReactNode

  /**
   * Short label, e.g. "Unclaimed items"
   */
  label: string

  /**
   * Count badge (e.g. 3). Omit or 0 to hide the badge.
   */
  count?: number

  /**
   * Called when the chip is tapped/clicked
   */
  onClick: () => void
}

export interface NeedsAttentionStripProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * The blockers/actions to render. Fully data-agnostic — feature teams
   * feed this from polls/claims/settlements/RSVP logic.
   */
  items: NeedsAttentionItem[]

  /**
   * Heading shown above the strip (defaults to "Needs your attention")
   */
  title?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Horizontally scrollable strip of "needs your attention" action chips.
 * Renders nothing when `items` is empty so callers can mount it
 * unconditionally.
 */
export function NeedsAttentionStrip({
  items,
  title = 'Needs your attention',
  className = '',
  ...props
}: NeedsAttentionStripProps) {
  if (items.length === 0) return null

  return (
    <div className={className} {...props}>
      <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2 px-0.5">
        {title}
      </h2>
      <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            onClick={item.onClick}
            className="
              flex items-center gap-2 shrink-0 rounded-[var(--radius-md)]
              border border-[var(--border-subtle)] bg-[var(--surface-raised)]
              pl-3 pr-3.5 py-2.5 shadow-sm
              hover:border-accent-300 hover:shadow-md
              active:scale-[0.98]
              transition-all duration-150
            "
          >
            <span className="text-accent-600 dark:text-accent-400 text-lg leading-none shrink-0" aria-hidden="true">
              {item.icon}
            </span>
            <span className="text-sm font-medium text-[var(--text-primary)] whitespace-nowrap">
              {item.label}
            </span>
            {!!item.count && item.count > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-danger-500 text-white text-[11px] font-bold leading-none">
                {item.count > 99 ? '99+' : item.count}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

NeedsAttentionStrip.displayName = 'NeedsAttentionStrip'
