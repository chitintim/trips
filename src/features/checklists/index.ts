/**
 * Shared checklist ("bring list") feature. Since the To-dos redesign (UX 2.3)
 * bring items are rendered by the one To-dos sheet (features/actions), grouped
 * with the other to-dos; this folder keeps only the table's Who-mode mapping.
 */
export { checklistWhoMode, checklistCanStore, checklistAssigneeFor } from './lib/checklistWho'
export type { ChecklistWhoRow } from './lib/checklistWho'
