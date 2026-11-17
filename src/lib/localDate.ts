/**
 * "Today" as the person using the app sees it: their LOCAL calendar date, as
 * YYYY-MM-DD. `new Date().toISOString().slice(0, 10)` is the UTC date, which
 * is yesterday for part of every day east of Greenwich (Japan, 00:00-08:59)
 * and for the first hour after midnight in UK summer. Use this wherever a form
 * or the FX lookup defaults to "today". Stored dates are never rewritten.
 */
export function toLocalDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function todayLocal(now: Date = new Date()): string {
  return toLocalDateString(now)
}
