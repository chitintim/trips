/**
 * Shared checklist feature (workstream G, plan §6.4). Decision: exported
 * as its OWN tab config (not folded into the brief page) — the checklist
 * is most useful during `awaiting_departure`/`trip_ongoing`, while the
 * brief is a gather-interest surface; the coordinator can also mount
 * <ChecklistTab tripId={...}/> inside another tab if the shell prefers.
 */
import type { ComponentType } from 'react'
import { ChecklistTab, type ChecklistTabProps } from './components/ChecklistTab'

export { ChecklistTab } from './components/ChecklistTab'
export type { ChecklistTabProps } from './components/ChecklistTab'

export const checklistTabConfig: {
  tabId: 'checklist'
  label: string
  icon: string
  Component: ComponentType<ChecklistTabProps>
} = {
  tabId: 'checklist',
  label: 'Checklist',
  icon: '🎒',
  Component: ChecklistTab,
}
