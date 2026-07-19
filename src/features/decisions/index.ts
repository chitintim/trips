// Public surface of the decisions feature (owns src/features/decisions/**).
//
// NOTE: the legacy `DecisionsTab`/`decisionsTabConfig` (and the SectionCard/
// OptionCard it alone consumed) were removed — TripDetail's v2.1 four-space
// nav (UX_REDESIGN.md) never mapped any space to this tab (see
// LEGACY_TAB_TO_SPACE in src/pages/TripDetail.tsx, which routes the old
// ?tab=decisions deep link straight to 'plan'), so the tab was unreachable
// dead code. Live consumers now reach these editors directly: MatrixView via
// PlanBoard's grid-view affordance, SectionEditorSheet via PlanBoard's tray
// "poll settings" affordance, OptionEditorSheet via PlanItemSheet's Edit
// affordance for option-backed items, and PasteALinkSheet via
// AddToPlanSheet's "paste a link" entry point.
export { MatrixView } from './components/MatrixView'
export { SectionEditorSheet } from './components/SectionEditorSheet'
export { OptionEditorSheet } from './components/OptionEditorSheet'
export { PasteALinkSheet } from './components/PasteALinkSheet'
export { CloseDecisionSheet } from './components/CloseDecisionSheet'
export { DecisionOutcomePanel } from './components/DecisionOutcomePanel'
export * from './lib/costImpact'
export * from './lib/voting'
export * from './lib/optionMetadata'
export * from './lib/decisionShapes'
export * from './lib/closeDecision'
