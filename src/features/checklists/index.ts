/**
 * Shared checklist feature. v2.1: the standalone Checklist TAB is dead —
 * "who's bringing what" is a people thing (UX_REDESIGN §4), so ChecklistTab
 * renders inside the People space's Checklist section and this barrel no
 * longer exports a tab config.
 */
export { ChecklistTab } from './components/ChecklistTab'
export type { ChecklistTabProps } from './components/ChecklistTab'
