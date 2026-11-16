import type { TodoGroups } from './todoModel'

/** Open items on the To-dos sheet (everything not Done / Left open). */
export function openSheetCount(groups: Pick<TodoGroups, 'yours' | 'everyone' | 'others' | 'upForGrabs'>): number {
  return groups.yours.length + groups.everyone.length + groups.others.length + groups.upForGrabs.length
}

/**
 * The footer row on Today's "Your to-dos" card that opens the To-dos sheet
 * (the only way in for participants besides deep links).
 * `mine` is the engine's personal count; the sheet count can be bigger because
 * it also lists other people's and up-for-grabs items.
 */
export function allTodosRowLabel(input: { openCount: number; mine: number; canCreate: boolean }): string | null {
  const { openCount, mine, canCreate } = input
  if (openCount > 0) return mine > 0 ? `All to-dos (${openCount} open) →` : "See everyone's to-dos →"
  return canCreate ? 'Add a to-do →' : null
}
