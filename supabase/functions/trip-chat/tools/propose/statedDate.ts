/**
 * Did the person's own message state this calendar date? Used so the assistant cannot silently book an expense
 * far in the past or in the future on a date the model made up or mis-computed: such a date is only accepted
 * when the person wrote it themselves (2026-03-04, 4 March, March 4th, 4/3, 3/4/2026 ...).
 * "yesterday" and "last week" do NOT count (the model has to compute those, and gets them wrong).
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep|sept', 'oct', 'nov', 'dec']

export function messageStatesDate(message: string, isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return false
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const text = message.toLowerCase()
  if (text.includes(isoDate)) return true
  const day = `0?${d}(?:st|nd|rd|th)?`
  const month = `(?:${MONTHS[mo - 1]}|${ABBR[mo - 1]})\\.?`
  const year = `(?:[ ,]+(?:${y}|${String(y).slice(2)}))?`
  const named = new RegExp(`(?:\\b${day}\\s+(?:of\\s+)?${month}${year}\\b|\\b${month}\\s+${day}${year}\\b)`)
  if (named.test(text)) return true
  const yr = `(?:[/.-](?:${y}|${String(y).slice(2)}))?`
  const numeric = new RegExp(`(?<![\\d/.-])(?:0?${d}[/.-]0?${mo}|0?${mo}[/.-]0?${d})${yr}(?![\\d/.-]*\\d)`)
  return numeric.test(text)
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). Positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}
