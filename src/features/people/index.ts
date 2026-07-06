import { PeopleTab } from './components/PeopleTab'

export { PeopleTab } from './components/PeopleTab'
export { ParticipantList } from './components/ParticipantList'
export { DependencyGraph } from './components/DependencyGraph'
export { WaitlistPanel } from './components/WaitlistPanel'
export { StatusModal } from './components/StatusModal'
export { ConfirmationSettingsSheet } from './components/ConfirmationSettingsSheet'
export * from './lib/dependencyGraph'
export * from './lib/waitlist'
export * from './lib/useWaitlistOffer'

/**
 * Tab config for the coordinator to wire into TripDetail's tab list
 * (per the coordination rule: workstream C does not edit TripDetail.tsx
 * directly). Icon left as a string emoji placeholder — swap for a
 * lucide-react icon at integration if the shell wants icon components
 * instead of emoji.
 */
export const peopleTabConfig = {
  tabId: 'people',
  label: 'People',
  icon: '👥',
  Component: PeopleTab,
}
