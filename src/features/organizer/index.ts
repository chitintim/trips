/**
 * Public surface of the organizer console feature (workstream G, plan §14
 * + §9 bookings tracker). Consumers mount `OrganizerConsole` directly and
 * are responsible for their own organizer-only gating; the component also
 * self-guards regardless (see OrganizerConsole.tsx).
 */
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
