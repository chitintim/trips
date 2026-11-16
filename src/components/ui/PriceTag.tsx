import type { OptionPrice } from '../../lib/cost/optionPrice'
import { priceSpokenText } from './priceTagText'

/**
 * The ONE way to show a price (proposal 4.1). Always the same two lines:
 *
 *   ≈£222 each                      <- headline: what ONE person pays (the only bold number)
 *   £2,000 total · 9 going · est.   <- basis line: unit, headcount, certainty
 *
 * Pass `price` (the result of `computeOptionPrice`), or `text` for a price
 * that does not come from an option (an own-choice catalog row: "£12/day
 * each"). Renders nothing when there is no price, unless `reserveSpace` is set
 * (then an empty box keeps the row height so lists do not jump).
 */
export type PriceTagSize = 'card' | 'inline' | 'detail'

export interface PriceTagProps {
  price?: OptionPrice | null
  /** Manual lines for prices not computed from an option. */
  text?: { headline: string; basisLine?: string | null } | null
  /** card: both lines, small (default). inline: one wrapping line. detail: larger, with the group-size sensitivity line. */
  size?: PriceTagSize
  /** Headline only (basis line left out, kept for screen readers). */
  compact?: boolean
  /** Show the group-size sensitivity line ("£250 each if 8 · £222 if 9"). Default: on for `detail` and `card`. */
  showSensitivity?: boolean
  /** Keep the row height when there is no price. */
  reserveSpace?: boolean
  className?: string
}

const SIZES: Record<PriceTagSize, { headline: string; basis: string; reserve: string }> = {
  card: { headline: 'text-sm', basis: 'text-xs', reserve: 'min-h-[2.25rem]' },
  inline: { headline: 'text-sm', basis: 'text-xs', reserve: 'min-h-[1.25rem]' },
  detail: { headline: 'text-lg', basis: 'text-sm', reserve: 'min-h-[3rem]' },
}

export function PriceTag({ price, text, size = 'card', compact = false, showSensitivity, reserveSpace = false, className = '' }: PriceTagProps) {
  const headline = price?.headline ?? text?.headline ?? null
  if (!headline) {
    return reserveSpace ? <span aria-hidden="true" className={`block ${SIZES[size].reserve} ${className}`} /> : null
  }
  const basisLine = price?.basisLine ?? text?.basisLine ?? null
  const sensitivityLine = (showSensitivity ?? size !== 'inline') && !compact ? price?.sensitivity?.line ?? null : null
  const s = SIZES[size]
  const spoken = priceSpokenText({ headline, basisLine, sensitivityLine, certainty: price?.certainty })

  const headlineEl = <span className={`${s.headline} font-semibold text-[var(--text-primary)]`}>{headline}</span>
  const basisEl = !compact && basisLine ? <span className={`${s.basis} text-[var(--text-muted)]`}>{basisLine}</span> : null

  return (
    <span
      className={`min-w-0 break-words ${size === 'inline' ? 'flex flex-wrap items-baseline gap-x-2' : 'flex flex-col'} ${className}`}
      data-testid="price-tag"
      data-certainty={price?.certainty}
    >
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true" className={size === 'inline' ? 'contents' : 'flex flex-col'}>
        {headlineEl}
        {basisEl}
        {sensitivityLine && <span className={`${s.basis} text-[var(--text-muted)]`}>{sensitivityLine}</span>}
      </span>
    </span>
  )
}
