/**
 * Display of a stored `quantity_claimed` that is not a whole number. Older
 * claims were typed as decimals (0.5, 0.33, 0.2 ...); show them the way people
 * say them. The column is numeric(10,2), so 1/3 is stored as 0.33 or 0.34.
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
  return quantity.toFixed(2)
}

/** "÷3" style label for a line shared equally between n people. */
export function formatShareDivisor(n: number): string {
  return `÷${n}`
}
