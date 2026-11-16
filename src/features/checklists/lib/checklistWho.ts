import type { WhoMode } from '../../actions/lib/todoLabels'

/**
 * Who-mode mapping for `trip_checklists` ("bring list") rows. No schema
 * change, and existing rows keep their CURRENT meaning:
 *
 *   assigned_to NULL     -> Anyone  ("first to grab it": nobody has claimed it yet)
 *   assigned_to = <user> -> a person (named, or someone who claimed it with "I'll bring it")
 *
 * "Everyone" (each person ticks their own) cannot be stored here: the table has
 * one `done` flag and no per-person completions. An Everyone to-do is therefore
 * always created in `trip_actions`, which has them.
 */
export interface ChecklistWhoRow {
  assigned_to: string | null
}

export function checklistWhoMode(item: ChecklistWhoRow): WhoMode {
  return item.assigned_to ? 'person' : 'anyone'
}

/** Whether a checklist row can hold this mode. */
export function checklistCanStore(mode: WhoMode): boolean {
  return mode !== 'everyone'
}

/** The `assigned_to` to write for a mode; null for 'anyone'. Throws for 'everyone' (not representable). */
export function checklistAssigneeFor(mode: WhoMode, personId: string | null | undefined): string | null {
  if (mode === 'everyone') throw new Error('An Everyone to-do cannot be stored as a bring item.')
  if (mode === 'person') {
    if (!personId) throw new Error('Choose who this is for.')
    return personId
  }
  return null
}
