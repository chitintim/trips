/**
 * Pure FX rate-date resolution (plan §11).
 *
 * Rules (single tested function, replacing the scattered logic in the
 * pre-v2 src/lib/currency.ts):
 *   - A future payment date -> use today (no rate exists yet).
 *   - A weekend/holiday payment date -> ECB only publishes on business
 *     days, so walk back to the most recent prior business day.
 *   - Otherwise -> use the payment date as-is.
 *
 * "Today" is passed in explicitly (not read from `new Date()` internally)
 * so the function is pure and trivially testable across timezones/instants.
 * All dates are date-only strings (YYYY-MM-DD), never Date objects, per
 * plan §16's date policy (avoids the timezone-drift bug class).
 *
 * Holidays: we only account for weekends here (Sat/Sun). Public holidays
 * are not hardcoded because ECB's specific non-publishing calendar shifts
 * per currency pair; the 3-tier fetch (memory -> fx_rates -> frankfurter ->
 * open.er-api) already falls back gracefully when a specific date has no
 * rate, and the caller is expected to retry walking further back on a
 * missing-rate response. This function guarantees weekend correctness,
 * which is the deterministic, testable part of the rule.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Parse a YYYY-MM-DD date-only string into a UTC-midnight epoch, avoiding
 * local-timezone parsing surprises. */
function parseDateOnly(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function formatDateOnly(epochMs: number): string {
  const d = new Date(epochMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 0 = Sunday ... 6 = Saturday (UTC). */
function getUtcDayOfWeek(epochMs: number): number {
  return new Date(epochMs).getUTCDay()
}

function isWeekend(epochMs: number): boolean {
  const dow = getUtcDayOfWeek(epochMs)
  return dow === 0 || dow === 6
}

export interface ResolveRateDateResult {
  /** The date to actually request/look up an FX rate for. */
  resolvedDate: string
  /** True if resolvedDate differs from the requested paymentDate. */
  wasAdjusted: boolean
  /** Why it was adjusted, if it was. */
  reason: 'future_date' | 'weekend' | 'none'
}

/**
 * Resolve which date to use for an FX rate lookup, given the expense's
 * payment date and "today" (both YYYY-MM-DD date-only strings).
 */
export function resolveRateDate(paymentDate: string, today: string): ResolveRateDateResult {
  const paymentMs = parseDateOnly(paymentDate)
  const todayMs = parseDateOnly(today)

  // Future date -> use today.
  if (paymentMs > todayMs) {
    return walkBackFromWeekend(todayMs, 'future_date')
  }

  // Not future: walk back off a weekend if needed.
  if (isWeekend(paymentMs)) {
    return walkBackFromWeekend(paymentMs, 'weekend')
  }

  return { resolvedDate: paymentDate, wasAdjusted: false, reason: 'none' }
}

/**
 * Walk backwards day-by-day from `startMs` until landing on a business day
 * (Mon-Fri). Used both for the "future date -> today" case (today itself
 * might be a weekend) and the "weekend payment date" case.
 */
function walkBackFromWeekend(startMs: number, reason: 'future_date' | 'weekend'): ResolveRateDateResult {
  let cursor = startMs
  while (isWeekend(cursor)) {
    cursor -= MS_PER_DAY
  }
  return {
    resolvedDate: formatDateOnly(cursor),
    wasAdjusted: true,
    reason,
  }
}
