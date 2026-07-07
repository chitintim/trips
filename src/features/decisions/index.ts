import { DecisionsTab } from './components/DecisionsTab'

export { DecisionsTab } from './components/DecisionsTab'
export { SectionCard } from './components/SectionCard'
export { OptionCard } from './components/OptionCard'
export { MatrixView } from './components/MatrixView'
export { SectionEditorSheet } from './components/SectionEditorSheet'
export { OptionEditorSheet } from './components/OptionEditorSheet'
export { PasteALinkSheet } from './components/PasteALinkSheet'
export * from './lib/costImpact'
export * from './lib/voting'
export * from './lib/optionMetadata'
export * from './lib/decisionShapes'

/**
 * Tab config for the coordinator to wire into TripDetail's tab list
 * (per the coordination rule: workstream C does not edit TripDetail.tsx
 * directly).
 */
export const decisionsTabConfig = {
  tabId: 'decisions',
  label: 'Decisions',
  icon: '🗳️',
  Component: DecisionsTab,
}
