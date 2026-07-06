/**
 * Trip retrospective feature (workstream G, plan §15). The coordinator
 * auto-shows this panel for `trip_completed` trips — `showWhen` encodes
 * the rule so the shell doesn't hardcode it.
 */
import type { ComponentType } from 'react'
import { RetrospectivePanel, type RetrospectivePanelProps } from './components/RetrospectivePanel'
import type { Trip } from '../../types'

export { RetrospectivePanel } from './components/RetrospectivePanel'
export type { RetrospectivePanelProps } from './components/RetrospectivePanel'
export { computeTripStats, formatMinor, categoryMeta, buildSummaryText, expenseBaseMinor } from './lib/tripStats'
export type { TripStats, CategoryTotal, PersonTotal, DayTotal, Superlatives } from './lib/tripStats'

export const retroConfig: {
  tabId: 'retro'
  label: string
  icon: string
  /** Coordinator: only show (and auto-open) for completed trips. */
  showWhen: (trip: Pick<Trip, 'status'>) => boolean
  Component: ComponentType<RetrospectivePanelProps>
} = {
  tabId: 'retro',
  label: 'Recap',
  icon: '🎉',
  showWhen: (trip) => trip.status === 'trip_completed',
  Component: RetrospectivePanel,
}
