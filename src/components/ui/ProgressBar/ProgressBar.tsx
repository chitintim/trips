import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Current value
   */
  value: number

  /**
   * Max value (defaults to 100, i.e. `value` is a percentage)
   */
  max?: number

  /**
   * Size of the bar
   */
  size?: 'sm' | 'md' | 'lg'

  /**
   * Color variant
   */
  variant?: 'accent' | 'success' | 'warn' | 'danger' | 'neutral'

  /**
   * Optional label shown above the bar
   */
  label?: string

  /**
   * Show the numeric percentage to the right of the label
   */
  showValue?: boolean
}

// ============================================================================
// COMPONENT
// ============================================================================

const sizeStyles = {
  sm: 'h-1.5',
  md: 'h-2',
  lg: 'h-3',
}

const variantStyles = {
  accent: 'bg-accent-500',
  success: 'bg-success-500',
  warn: 'bg-warn-500',
  danger: 'bg-danger-500',
  neutral: 'bg-neutral-400',
}

export const ProgressBar = forwardRef<HTMLDivElement, ProgressBarProps>(
  (
    {
      value,
      max = 100,
      size = 'md',
      variant = 'accent',
      label,
      showValue = false,
      className = '',
      ...props
    },
    ref
  ) => {
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0

    return (
      <div ref={ref} className={className} {...props}>
        {(label || showValue) && (
          <div className="flex items-center justify-between mb-1.5 text-sm">
            {label && <span className="font-medium text-[var(--text-primary)]">{label}</span>}
            {showValue && <span className="text-[var(--text-muted)]">{Math.round(pct)}%</span>}
          </div>
        )}
        <div
          className={`w-full rounded-[var(--radius-full)] bg-[var(--surface-sunken)] overflow-hidden ${sizeStyles[size]}`}
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
        >
          <div
            className={`h-full rounded-[var(--radius-full)] transition-all duration-300 ease-out ${variantStyles[variant]}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }
)

ProgressBar.displayName = 'ProgressBar'
