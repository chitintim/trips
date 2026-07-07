/**
 * Public surface of the Plan feature (UX_REDESIGN.md §2: the unified Plan
 * surface replacing the old Plan + Timeline + Map tabs). Other
 * features/pages should only import from this barrel, not from
 * src/features/plan/** internals directly.
 *
 * The coordinator wires `planTabConfig` into the app's tab/space list.
 * `PlanTab` takes `{ trip, onNavigate? }` — `onNavigate` is how the Plan
 * surface asks the shell to jump to another space (currently only "Money",
 * for a linked-expense chip tap); the coordinator supplies the actual
 * cross-space navigation behind that callback.
 */
import type { ComponentType } from 'react'
import { PlanTab, type PlanTabProps } from './components/PlanTab'

export { PlanTab } from './components/PlanTab'
export type { PlanTabProps } from './components/PlanTab'

export { PlanBoard } from './components/PlanBoard'
export type { PlanBoardProps } from './components/PlanBoard'

export { PlanMapLens } from './components/PlanMapLens'
export type { PlanMapLensProps } from './components/PlanMapLens'

export { PlanDecideLens } from './components/PlanDecideLens'
export type { PlanDecideLensProps } from './components/PlanDecideLens'

export { PlanItemCard } from './components/PlanItemCard'
export type { PlanItemCardProps } from './components/PlanItemCard'

export { PlanItemSheet } from './components/PlanItemSheet'
export type { PlanItemSheetProps } from './components/PlanItemSheet'

export { AddToPlanSheet } from './components/AddToPlanSheet'
export type { AddToPlanSheetProps } from './components/AddToPlanSheet'

export { ScheduleItSheet } from './components/ScheduleItSheet'
export type { ScheduleItSheetProps } from './components/ScheduleItSheet'

export {
  composePlanItems,
  groupPlanItemsByDate,
  getUndatedItems,
  groupUndatedBySection,
  getOpenVotables,
} from './lib/planItems'
export type {
  PlanItem,
  PlanItemStage,
  PlanItemVoteSummary,
  PlanItemCostImpact,
  PlanItemBookingInfo,
  ComposePlanItemsInput,
  ComposePlanItemsResult,
  SectionDateMetadata,
  OptionDateMetadata,
} from './lib/planItems'

export { usePlanItems } from './lib/usePlanItems'
export type { UsePlanItemsResult } from './lib/usePlanItems'

export const planTabConfig: {
  tabId: 'plan'
  label: string
  icon: string
  Component: ComponentType<PlanTabProps>
} = {
  tabId: 'plan',
  label: 'Plan',
  icon: '🧭',
  Component: PlanTab,
}
