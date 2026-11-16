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

// ---------------------------------------------------------------------------
// Grouped To-dos sheet (slice 2E): section headings, claim wording, empty state.
// One wording set for both tables; the only source-specific word is the verb
// ("I'll do it" for a to-do, "I'll bring it" for something to bring).
// ---------------------------------------------------------------------------

export const SECTION_YOURS = 'Yours'
export const SECTION_EVERYONE = 'Everyone'
export const SECTION_OTHERS = 'With others'
export const SECTION_GRABS = 'Up for grabs'
export const SECTION_DONE = 'Done'
/** Finished trips show to-dos as read-only history instead of as things to do. */
export const SECTION_LEFT_OPEN = 'Left open'

export const YOURS_EMPTY = 'Nothing for you right now.'
export const GRABS_HINT = 'Nobody is on these yet. Take one and it moves to your list.'

export const TODOS_EMPTY_TITLE = 'No to-dos.'
export const TODOS_EMPTY_BODY = "Add one for the group — like 'Book the transfer' or 'Bring a speaker'."
export const TODOS_FINISHED_NOTE = 'This trip has finished, so to-dos are shown as history.'
/** Finished trip, nothing in the sheet: the sheet only lists shared task to-dos; answering, paying and freezing live on Today. */
export const TODOS_FINISHED_EMPTY_TITLE = 'No shared to-dos were left open on this trip.'
export const TODOS_FINISHED_EMPTY_BODY = 'This list holds shared tasks. Answering, paying and freezing balances show on Today.'
export const NO_LONGER_NEEDED = '🗳️ No longer needed — the question is closed'
export const TICKS_WHEN_ANSWERED = '🗳️ Ticks off when you answer'

export const CLAIM_TODO = "I'll do it"
export const CLAIM_BRING = "I'll bring it"
export const UNCLAIM_LABEL = 'Give it back'

export function claimLabel(isBring: boolean): string {
  return isBring ? CLAIM_BRING : CLAIM_TODO
}

/** "Sam is on it" / "You're on it" for a claimed Anyone to-do. */
export function claimedByLabel(name: string | null, isMe: boolean, isBring: boolean): string {
  if (isMe) return isBring ? "You're bringing it" : "You're on it"
  const who = name || 'Someone'
  return isBring ? `${who} is bringing it` : `${who} is on it`
}

/** "Left: Sam, Priya and 2 more" — who still has to tick an Everyone to-do. */
export function leftLabel(names: string[], max = 3): string {
  if (names.length === 0) return ''
  if (names.length <= max) {
    if (names.length === 1) return `Left: ${names[0]}`
    return `Left: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  const shown = names.slice(0, max - 1)
  const more = names.length - shown.length
  return `Left: ${shown.join(', ')} and ${more} more`
}
