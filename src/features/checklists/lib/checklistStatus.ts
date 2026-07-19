/** Minimal checklist-item shape needed for relevance/count checks. */
export interface ChecklistItemStatusRef {
  done: boolean
  assigned_to: string | null
}

/**
 * Whether a bring-list item is unresolved AND relevant to `userId`,
 * matching ChecklistTab's completion model: an unassigned ("Anyone") item
 * concerns everyone until someone ticks it off; an assigned item concerns
 * only its assignee until they mark it packed. Done items concern nobody.
 */
export function isBringItemOpenForUser(item: ChecklistItemStatusRef, userId: string): boolean {
  if (item.done) return false
  return item.assigned_to === null || item.assigned_to === userId
}

/** Count of unresolved bring items relevant to `userId` (see isBringItemOpenForUser). */
export function openBringCountForUser(items: ChecklistItemStatusRef[] | null | undefined, userId: string | undefined): number {
  if (!userId) return 0
  return (items ?? []).filter((i) => isBringItemOpenForUser(i, userId)).length
}
