/**
 * To-do wording (UX redesign 2.1 / 2.3): actions, checklists and the bring
 * list are all "To-dos", with three explicit Who modes. Display only — the
 * storage (`trip_actions`, `trip_checklists`) is unchanged. Deliberately has
 * no imports so features/checklists can use it without a module cycle.
 *
 * | Who mode                      | Meaning                                  |
 * | Everyone                      | each person ticks their own (action, no assignee) |
 * | [Name]                        | one named person                         |
 * | Anyone — first to grab it     | one person needed, nobody named (checklist, no assignee) |
 */
export const TODOS_TITLE = 'To-dos'
export const NEW_TODO_LABEL = 'New to-do'
export const ADD_TODO_LABEL = 'Add to-do'
export const BRING_TAG = '🎒 Bring'

export type WhoMode = 'everyone' | 'person' | 'anyone'

export const WHO_EVERYONE = 'Everyone'
export const WHO_ANYONE = 'Anyone — first to grab it'

/** Label for a Who mode; `name` is used for 'person' (falls back to "Someone"). */
export function whoLabel(mode: WhoMode, name?: string | null): string {
  if (mode === 'everyone') return WHO_EVERYONE
  if (mode === 'anyone') return WHO_ANYONE
  return name || 'Someone'
}

/** The one done-count wording used by every to-do list: "3 of 9 done". */
export function doneCountLabel(done: number, total: number): string {
  return `${done} of ${total} done`
}

/** Dashboard badge: "1 to-do" / "3 to-dos". */
export function todoCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'to-do' : 'to-dos'}`
}
