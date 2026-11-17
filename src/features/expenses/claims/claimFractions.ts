/**
 * Display of a stored `quantity_claimed` that is not a whole number. Older
 * claims were typed as decimals (0.5, 0.33, 0.2 ...); show them the way people
 * say them. The column is numeric(10,2), so 1/3 is stored as 0.33 or 0.34.
 * Anything that is not a simple fraction is a percentage of the item ("7%"),
 * never a bare decimal.
 */
const FRACTIONS: Array<[number, string]> = [
  [1 / 2, '½'],
  [1 / 3, '⅓'],
  [2 / 3, '⅔'],
  [1 / 4, '¼'],
  [3 / 4, '¾'],
  [1 / 5, '⅕'],
  [2 / 5, '⅖'],
  [3 / 5, '⅗'],
  [4 / 5, '⅘'],
  [1 / 6, '⅙'],
  [5 / 6, '⅚'],
  [1 / 8, '⅛'],
  [1 / 10, '1/10'],
]

const TOLERANCE = 0.0075

export function formatClaimQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) return ''
  const whole = Math.floor(quantity + TOLERANCE)
  const rest = quantity - whole
  if (Math.abs(rest) < TOLERANCE) return String(whole)
  // 0.1 is "1/10" only when it is really a tenth, not 0.12 or 0.09.
  for (const [value, label] of FRACTIONS) {
    const tol = value === 1 / 8 || value === 1 / 10 ? 0.0025 : TOLERANCE
    if (Math.abs(rest - value) <= tol) return whole > 0 ? `${whole}${label}` : label
  }
  const pct = percentLabel(rest)
  return whole > 0 ? `${whole} + ${pct}` : pct
}

/** "7%", "30%"; "<1%" for a sliver; never a decimal. Input is the fraction of one item (0.07). */
function percentLabel(fraction: number): string {
  const pct = Math.round(fraction * 100)
  if (pct <= 0) return '<1%'
  if (pct >= 100) return '99%'
  return `${pct}%`
}

const SHARE_TOLERANCE = 0.011

/**
 * A person's real share of an item as words: the quantity they hold out of the item's quantity ("⅕", "⅔", "7%", "all of it").
 * `quantity` and `lineQuantity` are in the item's own units (2 of 3 = ⅔).
 */
export function formatShareOfItem(quantity: number, lineQuantity: number): string {
  if (!Number.isFinite(quantity) || !Number.isFinite(lineQuantity) || lineQuantity <= 0) return formatClaimQuantity(quantity)
  const ratio = quantity / lineQuantity
  if (Math.abs(ratio - 1) <= SHARE_TOLERANCE) return 'all of it'
  return formatClaimQuantity(ratio)
}

/**
 * The words for "You: <this> — €x" on a line that is shared. "÷N share" only when the line really is an equal split between N people
 * (everyone holds the same share and together they hold the whole item); otherwise the person's actual share.
 */
export function describeMyShare(args: { myQuantity: number; lineQuantity: number; allQuantities: number[] }): string {
  const { myQuantity, lineQuantity, allQuantities } = args
  const n = allQuantities.length
  if (n > 1 && lineQuantity > 0) {
    const equal = Math.max(...allQuantities) - Math.min(...allQuantities) <= SHARE_TOLERANCE
    const total = allQuantities.reduce((a, b) => a + b, 0)
    const whole = Math.abs(total - lineQuantity) <= SHARE_TOLERANCE * Math.max(1, n)
    if (equal && whole && Math.abs(myQuantity - lineQuantity / n) <= SHARE_TOLERANCE) return formatShareDivisor(n) + ' share'
  }
  return formatShareOfItem(myQuantity, lineQuantity)
}

/** "÷3" style label for a line shared equally between n people. */
export function formatShareDivisor(n: number): string {
  return `÷${n}`
}
