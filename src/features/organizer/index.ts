/**
 * Public surface of the organizer console feature (workstream G, plan §14
 * + §9 bookings tracker). The coordinator wires organizerTabConfig into
 * TripDetail's tab list — the tab must only be shown to organizers
 * (organizerOnly flag), and the component self-guards regardless.
 */
import type { ComponentType } from 'react'
import { OrganizerConsole, type OrganizerConsoleProps } from './components/OrganizerConsole'

export { OrganizerConsole } from './components/OrganizerConsole'
export type { OrganizerConsoleProps } from './components/OrganizerConsole'
export { BlockersBoard } from './components/BlockersBoard'
export { BookingsTracker } from './components/BookingsTracker'
export { BookingEditorSheet } from './components/BookingEditorSheet'
export type { BookingEditorSheetProps } from './components/BookingEditorSheet'
export { ActivityFeedPanel } from './components/ActivityFeedPanel'
export { ChaseSettingsSheet } from './components/ChaseSettingsSheet'
export type { ChaseSettingsSheetProps } from './components/ChaseSettingsSheet'
export { NudgeDraftSheet } from './components/NudgeDraftSheet'
export type { NudgeDraftSheetProps } from './components/NudgeDraftSheet'

// Activity logging helper — usable by every feature (typed verbs), see
// lib/activity.ts header for the coordinator's wiring list.
export { useTripActivityLog, renderActivity } from './lib/activity'
export type { ActivityVerb, ActivityEntity, LogActivityInput, RenderedActivity } from './lib/activity'

// Pure libs (blockers computation, chase settings contract).
export { computeBlockers } from './lib/blockers'
export type { Blocker, BlockerKind, PersonBlockers, BlockersBoardData } from './lib/blockers'
export { parseChaseSettings, DEFAULT_CHASE_SETTINGS } from './lib/chaseSettings'
export type { ChaseSettings } from './lib/chaseSettings'
export { requestNudgeDraft, NudgeQuotaError } from './lib/nudgeClient'

export const organizerTabConfig: {
  tabId: 'organizer'
  label: string
  icon: string
  /** Coordinator: hide this tab for non-organizers. */
  organizerOnly: true
  Component: ComponentType<OrganizerConsoleProps>
} = {
  tabId: 'organizer',
  label: 'Console',
  icon: '🎛️',
  organizerOnly: true,
  Component: OrganizerConsole,
}
