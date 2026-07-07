/**
 * Public surface of the Today feature — the stage-aware trip home
 * (UX_REDESIGN §1 + Part 2 layouts). The shell wires `todayTabConfig` as
 * the first of the four spaces (Today · Plan · Money · People) and supplies
 * the cross-space callbacks in TodayTabProps.
 */
import type { ComponentType } from 'react'
import { TodayTab, type TodayTabProps } from './components/TodayTab'

export { TodayTab } from './components/TodayTab'
export type { TodayTabProps } from './components/TodayTab'

export { computeStageSuggestion } from './lib/stageSuggestions'
export type { StageSuggestion, StageSuggestionInput } from './lib/stageSuggestions'
export {
  parseDatesPending,
  mergeChaseSettingsJson,
  optionDateRange,
  computeDatePollWinner,
  isDatePollClosed,
  TRIP_DATES_SECTION_TITLE,
} from './lib/datePoll'
export type { DateRange, DatesPendingState, DatePollWinner } from './lib/datePoll'
export { isCardDismissed, dismissCard } from './lib/dismissals'

export const todayTabConfig: {
  tabId: 'today'
  label: string
  icon: string
  Component: ComponentType<TodayTabProps>
} = {
  tabId: 'today',
  label: 'Today',
  icon: '☀️',
  Component: TodayTab,
}
