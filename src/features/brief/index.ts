import { TripBrief } from './components/TripBrief'

export { TripBrief } from './components/TripBrief'
export { FaqAccordion } from './components/FaqAccordion'
export * from './lib/costBand'
export * from './lib/autoFaq'

/**
 * Tab config for the coordinator to wire as the stage-aware trip home
 * during gathering_interest/confirming_participants (per plan §5/§6 — the
 * "Today"/"Settle up" variants for other stages are other workstreams'
 * concern; this is specifically the brief for pre-confirmation stages).
 */
export const briefTabConfig = {
  tabId: 'brief',
  label: 'Brief',
  icon: '📋',
  Component: TripBrief,
}
