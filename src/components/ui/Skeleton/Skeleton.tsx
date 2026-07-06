import { HTMLAttributes, forwardRef } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Shape variant
   * - text: a single line of text (or multiple with `lines`)
   * - card: a rectangular block sized like a card
   * - avatar: a circle sized like an Avatar
   * - list: a stacked list of row skeletons (icon + two lines)
   */
  variant?: 'text' | 'card' | 'avatar' | 'list'

  /**
   * Number of lines (text variant) or rows (list variant)
   */
  lines?: number

  /**
   * Width override (any CSS width value)
   */
  width?: string | number

  /**
   * Height override (any CSS height value), used by 'card'
   */
  height?: string | number
}

// ============================================================================
// COMPONENT
// ============================================================================

const shimmer = 'animate-[fable-skeleton-pulse_1.5s_ease-in-out_infinite] bg-[var(--surface-sunken)]'

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  (
    { variant = 'text', lines = 3, width, height, className = '', style, ...props },
    ref
  ) => {
    if (variant === 'avatar') {
      return (
        <div
          ref={ref}
          role="status"
          aria-label="Loading"
          className={`rounded-full ${shimmer} ${className}`}
          style={{ width: width ?? 40, height: height ?? 40, ...style }}
          {...props}
        />
      )
    }

    if (variant === 'card') {
      return (
        <div
          ref={ref}
          role="status"
          aria-label="Loading"
          className={`rounded-[var(--radius-lg)] ${shimmer} ${className}`}
          style={{ width: width ?? '100%', height: height ?? 120, ...style }}
          {...props}
        />
      )
    }

    if (variant === 'list') {
      return (
        <div ref={ref} role="status" aria-label="Loading" className={`space-y-3 ${className}`} {...props}>
          {Array.from({ length: lines }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className={`rounded-full shrink-0 ${shimmer}`} style={{ width: 40, height: 40 }} />
              <div className="flex-1 space-y-2">
                <div className={`rounded-[var(--radius-xs)] ${shimmer}`} style={{ width: '60%', height: 12 }} />
                <div className={`rounded-[var(--radius-xs)] ${shimmer}`} style={{ width: '35%', height: 10 }} />
              </div>
            </div>
          ))}
        </div>
      )
    }

    // text
    return (
      <div ref={ref} role="status" aria-label="Loading" className={`space-y-2 ${className}`} style={style} {...props}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`rounded-[var(--radius-xs)] ${shimmer}`}
            style={{
              width: width ?? (i === lines - 1 && lines > 1 ? '70%' : '100%'),
              height: 12,
            }}
          />
        ))}
      </div>
    )
  }
)

Skeleton.displayName = 'Skeleton'
