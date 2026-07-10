/**
 * Public surface of the timeline feature (owns src/features/timeline/**).
 * Other features/pages should only import from this barrel.
 *
 * NOTE: the legacy `TimelineTab`/`timelineTabConfig` (and the
 * `TimelineEventCard` it alone consumed) were removed — TripDetail's v2.1
 * four-space nav (UX_REDESIGN.md) never mapped any space to this tab (see
 * LEGACY_TAB_TO_SPACE in src/pages/TripDetail.tsx, which routes the old
 * ?tab=timeline deep link straight to 'plan'), so the tab was unreachable
 * dead code. The live itinerary surface is PlanBoard's List lens
 * (src/features/plan/components/PlanBoard.tsx), which already reuses this
 * feature's EventEditorSheet/dayGrouping/categoryConfig exports directly.
 *
 * `OPEN_QUICK_CAPTURE_EVENT` is kept exported even though TimelineTab was
 * its only dispatcher: src/pages/TripDetail.tsx (out of this workstream's
 * ownership) still imports it and registers a `window` listener for it, so
 * removing the export would break that page's build. The listener is now a
 * harmless no-op (nothing dispatches the event anymore) — flagged in the
 * audit report rather than silently left, since re-wiring a dispatcher is a
 * TripDetail-side call the coordinator/owning agent should make.
 */
export { EventEditorSheet } from './components/EventEditorSheet'
export type { EventEditorSheetProps } from './components/EventEditorSheet'

export {
  formatLocalDate,
  generateDateRange,
  formatDayHeader,
  computeTimelineDateRange,
  groupEventsByDate,
  computeDefaultCollapsedDays,
  classifyDay,
  findNextUpEvent,
} from './lib/dayGrouping'
export type { DayHeaderInfo, DayBucket } from './lib/dayGrouping'

export { CATEGORY_CONFIG, CATEGORY_OPTIONS, formatTime, formatTimeRange } from './lib/categoryConfig'
export type { CategoryStyle } from './lib/categoryConfig'

/** The event name TimelineTab's empty state used to dispatch — see module doc above. */
export const OPEN_QUICK_CAPTURE_EVENT = 'open-quick-capture'
