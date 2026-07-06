import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

/**
 * "Trip in numbers" computation for the retrospective (plan §15). Pure —
 * takes fetched expenses and returns totals in the trip base currency,
 * computed in integer minor units via the money module (never float
 * arithmetic on money).
 *
 * Cross-currency expenses use their stored base_currency_amount (locked at
 * payment date by the FX pipeline); when it's missing we fall back to the
 * raw amount only for same-currency expenses and skip the rest (flagged in
 * `skippedCount`) rather than silently mixing currencies.
 */

export interface CategoryTotal {
  category: string
  amountMinor: number
}

export interface PersonTotal {
  userId: string
  amountMinor: number
}

export interface DayTotal {
  /** YYYY-MM-DD */
  date: string
  amountMinor: number
}

export interface Superlatives {
  mostExpensiveMeal: { description: string; amountMinor: number } | null
  cheapestDay: DayTotal | null
  biggestSpendDay: DayTotal | null
  biggestPayer: PersonTotal | null
}

export interface TripStats {
  baseCurrency: string
  totalMinor: number
  expenseCount: number
  byCategory: CategoryTotal[]
  byPerson: PersonTotal[]
  byDay: DayTotal[]
  superlatives: Superlatives
  /** Expenses that couldn't be converted to base currency and were excluded. */
  skippedCount: number
}

/** Base-currency minor units for one expense, or null when unconvertible. */
export function expenseBaseMinor(expense: ExpenseWithDetails, baseCurrency: string): number | null {
  if (expense.currency === baseCurrency) {
    return toMinorUnits(expense.amount, baseCurrency)
  }
  if (expense.base_currency_amount != null) {
    return toMinorUnits(expense.base_currency_amount, baseCurrency)
  }
  return null
}

export function computeTripStats(expenses: ExpenseWithDetails[], baseCurrency: string): TripStats {
  let totalMinor = 0
  let skippedCount = 0
  const byCategory = new Map<string, number>()
  const byPerson = new Map<string, number>()
  const byDay = new Map<string, number>()
  let mostExpensiveMeal: Superlatives['mostExpensiveMeal'] = null

  for (const expense of expenses) {
    const minor = expenseBaseMinor(expense, baseCurrency)
    if (minor == null) {
      skippedCount++
      continue
    }
    totalMinor += minor
    byCategory.set(expense.category, (byCategory.get(expense.category) ?? 0) + minor)
    byPerson.set(expense.paid_by, (byPerson.get(expense.paid_by) ?? 0) + minor)
    const day = expense.payment_date?.slice(0, 10)
    if (day) byDay.set(day, (byDay.get(day) ?? 0) + minor)

    if (expense.category === 'food' && minor > 0 && (!mostExpensiveMeal || minor > mostExpensiveMeal.amountMinor)) {
      mostExpensiveMeal = { description: expense.description, amountMinor: minor }
    }
  }

  const categoryTotals: CategoryTotal[] = [...byCategory.entries()]
    .map(([category, amountMinor]) => ({ category, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor)
  const personTotals: PersonTotal[] = [...byPerson.entries()]
    .map(([userId, amountMinor]) => ({ userId, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor)
  const dayTotals: DayTotal[] = [...byDay.entries()]
    .map(([date, amountMinor]) => ({ date, amountMinor }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const spendingDays = dayTotals.filter((d) => d.amountMinor > 0)
  const cheapestDay = spendingDays.length > 0 ? spendingDays.reduce((min, d) => (d.amountMinor < min.amountMinor ? d : min)) : null
  const biggestSpendDay = spendingDays.length > 0 ? spendingDays.reduce((max, d) => (d.amountMinor > max.amountMinor ? d : max)) : null

  return {
    baseCurrency,
    totalMinor,
    expenseCount: expenses.length - skippedCount,
    byCategory: categoryTotals,
    byPerson: personTotals,
    byDay: dayTotals,
    superlatives: {
      mostExpensiveMeal,
      cheapestDay,
      biggestSpendDay,
      biggestPayer: personTotals[0] ?? null,
    },
    skippedCount,
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$', JPY: '¥', CHF: 'CHF ', AUD: 'A$', CAD: 'C$' }

/** Display a minor-unit amount in base currency, e.g. 123456 -> "£1,234.56". */
export function formatMinor(amountMinor: number, currency: string): string {
  const major = fromMinorUnits(amountMinor, currency)
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `
  return `${symbol}${major.toLocaleString(undefined, {
    minimumFractionDigits: currency === 'JPY' ? 0 : 2,
    maximumFractionDigits: currency === 'JPY' ? 0 : 2,
  })}`
}

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  accommodation: { icon: '🏠', label: 'Accommodation' },
  transport: { icon: '🚆', label: 'Transport' },
  food: { icon: '🍜', label: 'Food & drink' },
  activities: { icon: '🎿', label: 'Activities' },
  equipment: { icon: '🎒', label: 'Equipment' },
  other: { icon: '📦', label: 'Other' },
}

export function categoryMeta(category: string): { icon: string; label: string } {
  return CATEGORY_META[category] ?? { icon: '📦', label: category }
}

/** Plain-text shareable summary (the "copy summary text" button). */
export function buildSummaryText(
  tripName: string,
  stats: TripStats,
  namesById: Map<string, string>
): string {
  const lines: string[] = [`${tripName} — trip in numbers`, '']
  lines.push(`💷 Total spent: ${formatMinor(stats.totalMinor, stats.baseCurrency)} across ${stats.expenseCount} expenses`)
  if (stats.byCategory.length > 0) {
    lines.push('')
    lines.push('By category:')
    for (const c of stats.byCategory) {
      const meta = categoryMeta(c.category)
      lines.push(`  ${meta.icon} ${meta.label}: ${formatMinor(c.amountMinor, stats.baseCurrency)}`)
    }
  }
  const s = stats.superlatives
  const superlativeLines = [
    s.biggestPayer
      ? `🏆 Biggest payer: ${namesById.get(s.biggestPayer.userId) ?? 'Someone'} (${formatMinor(s.biggestPayer.amountMinor, stats.baseCurrency)})`
      : null,
    s.mostExpensiveMeal
      ? `🍽️ Most expensive meal: "${s.mostExpensiveMeal.description}" (${formatMinor(s.mostExpensiveMeal.amountMinor, stats.baseCurrency)})`
      : null,
    s.cheapestDay ? `🪙 Cheapest day: ${s.cheapestDay.date} (${formatMinor(s.cheapestDay.amountMinor, stats.baseCurrency)})` : null,
    s.biggestSpendDay
      ? `🔥 Biggest day: ${s.biggestSpendDay.date} (${formatMinor(s.biggestSpendDay.amountMinor, stats.baseCurrency)})`
      : null,
  ].filter(Boolean) as string[]
  if (superlativeLines.length > 0) {
    lines.push('')
    lines.push(...superlativeLines)
  }
  return lines.join('\n')
}
