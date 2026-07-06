import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Small label above the value (e.g. "Total spent")
   */
  label: string

  /**
   * Main value (e.g. "£1,240.50")
   */
  value: string | number

  /**
   * Optional delta/change indicator (e.g. "+£120 vs estimate", "-4%")
   */
  delta?: string

  /**
   * Direction of the delta, drives color (up=success by default unless
   * `deltaInverse` flips it, e.g. spend increases are usually bad)
   */
  deltaDirection?: 'up' | 'down' | 'neutral'

  /**
   * When true, an "up" delta is styled as bad (danger) and "down" as good
   * (success) — useful for spend/overspend stats where more is worse.
   */
  deltaInverse?: boolean

  /**
   * Icon shown top-right (e.g. a lucide-react icon)
   */
  icon?: React.ReactNode

  /**
   * Visual size
   */
  size?: 'sm' | 'md'
}

// ============================================================================
// COMPONENT
// ============================================================================

export const StatCard = forwardRef<HTMLDivElement, StatCardProps>(
  (
    {
      label,
      value,
      delta,
      deltaDirection = 'neutral',
      deltaInverse = false,
      icon,
      size = 'md',
      className = '',
      ...props
    },
    ref
  ) => {
    const isGood = deltaInverse ? deltaDirection === 'down' : deltaDirection === 'up'
    const isBad = deltaInverse ? deltaDirection === 'up' : deltaDirection === 'down'

    const deltaColor = isGood
      ? 'text-success-600 dark:text-success-400'
      : isBad
      ? 'text-danger-600 dark:text-danger-400'
      : 'text-[var(--text-muted)]'

    return (
      <div
        ref={ref}
        className={`
          rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-sm
          ${size === 'sm' ? 'p-3.5' : 'p-5'}
          ${className}
        `.trim().replace(/\s+/g, ' ')}
        {...props}
      >
        <div className="flex items-start justify-between gap-2">
          <span className={`font-medium text-[var(--text-secondary)] ${size === 'sm' ? 'text-xs' : 'text-sm'}`}>
            {label}
          </span>
          {icon && (
            <span className="text-accent-600 dark:text-accent-400 shrink-0" aria-hidden="true">
              {icon}
            </span>
          )}
        </div>

        <div className={`font-semibold text-[var(--text-primary)] tabular-nums tracking-tight ${size === 'sm' ? 'text-xl mt-1' : 'text-2xl mt-1.5'}`}>
          {value}
        </div>

        {delta && (
          <div className={`mt-1 text-xs font-medium ${deltaColor}`}>
            {deltaDirection === 'up' && '↑ '}
            {deltaDirection === 'down' && '↓ '}
            {delta}
          </div>
        )}
      </div>
    )
  }
)

StatCard.displayName = 'StatCard'
