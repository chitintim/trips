/**
 * Trip retrospective feature (workstream G, plan §15). The coordinator
 * auto-shows this panel for `trip_completed` trips -- that rule lives with
 * the coordinator itself, not here (retroConfig used to carry a `showWhen`
 * field for it, but nothing ever consumed it, so it was removed).
 */
import type { ComponentType } from 'react'
import { lazyWithRetry } from '../../lib/lazyWithRetry'
import type { RetrospectivePanelProps } from './components/RetrospectivePanel'

export type { RetrospectivePanelProps } from './components/RetrospectivePanel'
export { computeTripStats, formatMinor, categoryMeta, buildSummaryText, expenseBaseMinor } from './lib/tripStats'
export type { TripStats, CategoryTotal, PersonTotal, DayTotal, Superlatives } from './lib/tripStats'

/**
 * `RetrospectivePanel` (and its leaflet-dependent PlaceMapThumb usage,
 * superlative charts, share-image rendering) is loaded via React.lazy (WSH
 * perf pass, plan §16 code-splitting target) -- it's only relevant for
 * trip_completed trips, so most sessions never need this JS at all.
 */
export const retroConfig: {
  tabId: 'retro'
  label: string
  icon: string
  Component: ComponentType<RetrospectivePanelProps>
} = {
  tabId: 'retro',
  label: 'Recap',
  icon: '🎉',
  Component: lazyWithRetry(() => import('./components/RetrospectivePanel').then((m) => ({ default: m.RetrospectivePanel }))),
}
