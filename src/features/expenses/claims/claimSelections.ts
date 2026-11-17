/** A person's whole-unit claims per line: line id -> quantity. */
export type Selections = Record<string, number>

/**
 * The server's claims changed (a save, someone else's tap, the payer re-itemising). Lines the person has not touched since the last
 * known server state follow the new state; lines they edited and have not saved keep their edit. Without this, a change made elsewhere
 * (e.g. on "Who had what") left the steppers looking unsaved forever, and the browser's "Leave site?" prompt stayed on.
 */
export function resyncSelections(local: Selections, prevSaved: Selections, nextSaved: Selections): Selections {
  const next: Selections = {}
  const keys = new Set([...Object.keys(local), ...Object.keys(prevSaved), ...Object.keys(nextSaved)])
  for (const key of keys) {
    const touched = (local[key] ?? 0) !== (prevSaved[key] ?? 0)
    const value = touched ? local[key] : nextSaved[key]
    if (value !== undefined) next[key] = value
  }
  return next
}
