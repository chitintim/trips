/**
 * "Add a to-do" after a decision is two client writes: create the to-do, then
 * stamp its id into the question (`metadata.followup_action_id`) so the outcome
 * can show it. The stamp is best effort: it re-reads the question's CURRENT
 * metadata and merges (never overwrites other keys), and if it fails the
 * to-do still exists, so the caller reports "added, but not linked" instead of
 * failure. Pure over injected writers; unit-tested.
 */
import type { Json } from '../../../types/database.types'
import { buildDecisionMetadata } from './closeDecision'

export interface AddTodoDeps<A extends { id: string }> {
  createAction: () => Promise<A>
  /** The question's metadata as it is now (not a possibly stale prop). */
  readMetadata: () => Promise<Json | null>
  writeMetadata: (metadata: Json) => Promise<void>
}

export type AddTodoOutcome<A extends { id: string }> = { action: A; linked: true } | { action: A; linked: false; linkError: string }

/** Throws only when the to-do itself could not be created. */
export async function addTodoAndLink<A extends { id: string }>(deps: AddTodoDeps<A>): Promise<AddTodoOutcome<A>> {
  const action = await deps.createAction()
  try {
    const current = await deps.readMetadata()
    await deps.writeMetadata(buildDecisionMetadata(current, { followup_action_id: action.id }))
    return { action, linked: true }
  } catch (err) {
    return { action, linked: false, linkError: err instanceof Error ? err.message : 'Could not link it to the question.' }
  }
}

export const TODO_NOT_LINKED_NOTE = 'It is on the list, but it is not linked to this question, so the question will not show it.'
