/**
 * Public surface of the timeline feature (owns src/features/timeline/**).
 * Other features/pages should only import from this barrel.
 *
 * Empty-state quick-capture contract: TimelineTab's empty state dispatches
 * `window.dispatchEvent(new CustomEvent('open-quick-capture'))` when the
 * organizer taps "Paste a booking". The app shell (or whichever component
 * owns the quick-capture "+" flow) should add a `window` listener for the
 * `open-quick-capture` event and open its quick-capture sheet in response —
 * this lets any empty state in the app invite the same fast path without
 * importing the shell's internals or the quick-capture feature directly.
 */
import type { ComponentType } from 'react'
import { TimelineTab, type TimelineTabProps } from './components/TimelineTab'

export { TimelineTab } from './components/TimelineTab'
export type { TimelineTabProps } from './components/TimelineTab'

export { EventEditorSheet } from './components/EventEditorSheet'
export type { EventEditorSheetProps } from './components/EventEditorSheet'

export { TimelineEventCard } from './components/TimelineEventCard'
export type { TimelineEventCardProps } from './components/TimelineEventCard'

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

/** The event name TimelineTab's empty state dispatches — see module doc above. */
export const OPEN_QUICK_CAPTURE_EVENT = 'open-quick-capture'

export const timelineTabConfig: {
  tabId: 'timeline'
  label: string
  icon: string
  Component: ComponentType<TimelineTabProps>
} = {
  tabId: 'timeline',
  label: 'Timeline',
  icon: '🗓️',
  Component: TimelineTab,
}
