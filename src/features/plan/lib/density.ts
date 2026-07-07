/**
 * Display density (UX_REDESIGN.md Part 4/5 "glanceability" concerns, no AI
 * involved): busy or past days shouldn't force a wall of full item cards.
 * Pure logic only — no React, no Supabase — so every rule here is
 * unit-testable in isolation; PlanBoard/PlanItemCard consume it.
 *
 *  - A day is "dense" when it's in the past, or has more than
 *    DENSE_ITEM_THRESHOLD items — decided/booked items on a dense day
 *    render as one-line PlanItemCards (see PlanItemCard's `dense` prop)
 *    and collapse behind a summary line ("6 items · 2 meals · transfer")
 *    that expands on tap.
 *  - Proposals/ideas ALWAYS render as full cards regardless of density —
 *    they still need the reviewer's attention, so they're never counted
 *    into a collapsed summary and never rendered dense.
 *  - The expanded/collapsed choice per day is remembered in
 *    sessionStorage (per trip) so scrolling away and back doesn't
 *    re-collapse a day the user just opened.
 */
import type { PlanItem } from './planItems'

/** More than this many items on a day is "busy" — collapse behind a summary line even if the day isn't in the past. */
export const DENSE_ITEM_THRESHOLD = 4

/** True when `date` (YYYY-MM-DD) is strictly before `today` (YYYY-MM-DD) — plain string comparison, both date-only, no timezone conversion (calendar edge case #8: dates are destination-local naive). */
export function isPastDay(date: string, today: string): boolean {
  return date < today
}

/** A day qualifies for density treatment when it's already happened, or has more items than comfortably fit without scanning. */
export function shouldDensifyDay(dayItemCount: number, date: string, today: string): boolean {
  return isPastDay(date, today) || dayItemCount > DENSE_ITEM_THRESHOLD
}

/** Only decided/booked items are ever rendered dense — proposals/ideas keep full cards no matter how busy or past the day is. */
export function isDensifiableStage(stage: PlanItem['stage']): boolean {
  return stage === 'decided' || stage === 'booked'
}

const CATEGORY_SUMMARY_LABELS: Record<string, { singular: string; plural: string }> = {
  flight: { singular: 'flight', plural: 'flights' },
  accommodation: { singular: 'accommodation', plural: 'accommodation' },
  transport: { singular: 'transport', plural: 'transport' },
  activity: { singular: 'activity', plural: 'activities' },
  dining: { singular: 'meal', plural: 'meals' },
  transfer: { singular: 'transfer', plural: 'transfers' },
  meeting_point: { singular: 'meeting point', plural: 'meeting points' },
  free_time: { singular: 'free time', plural: 'free time' },
  other: { singular: 'item', plural: 'items' },
}

/** "6 items · 2 meals · transfer" — total count plus up to 3 category breakdowns, in a stable category order so the line doesn't reshuffle as data changes. */
export function summarizeDayItems(items: Pick<PlanItem, 'category'>[]): string {
  const total = items.length
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = item.category ?? 'other'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const category of Object.keys(CATEGORY_SUMMARY_LABELS)) {
    // "other"/uncategorized items only count toward the total — a
    // breakdown part like "2 items" alongside "6 items" is just noise.
    if (category === 'other') continue
    const n = counts.get(category)
    if (!n) continue
    const label = CATEGORY_SUMMARY_LABELS[category]
    parts.push(`${n} ${n === 1 ? label.singular : label.plural}`)
    if (parts.length === 3) break
  }
  const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  return `${total} item${total === 1 ? '' : 's'}${suffix}`
}

// ---------------------------------------------------------------------------
// Expanded-day persistence (sessionStorage, per trip) — a dense day starts
// collapsed; expanding it (or a past day the user opened earlier this tab
// session) is remembered so re-rendering/scrolling doesn't fight the user.
// ---------------------------------------------------------------------------

function storageKey(tripId: string): string {
  return `plan-expanded-days:${tripId}`
}

export function loadExpandedDays(tripId: string): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(storageKey(tripId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveExpandedDays(tripId: string, expanded: Set<string>): void {
  try {
    window.sessionStorage.setItem(storageKey(tripId), JSON.stringify([...expanded]))
  } catch {
    // Storage unavailable (private browsing, quota) — expand/collapse still works for this render, just doesn't persist.
  }
}
