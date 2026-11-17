import type { QueryClient } from '@tanstack/react-query'

/**
 * Data-only description of how to reverse a self-only write (untick my to-do, give a claim back, restore my
 * previous answer). It names the exported plain function to call and the arguments to call it with; nothing
 * here runs anything. Callers (the trip chat's Undo) execute it through the same function the screens use.
 */
export interface UndoDescriptor<Fn extends string = string, Args extends unknown[] = unknown[]> {
  /** Name of the exported plain function that reverses the write. */
  fn: Fn
  /** The arguments to pass to it, in order. */
  args: Args
  /** Short plain wording for the Undo button or toast ("Untick this to-do"). */
  label: string
}

/** The query client the `invalidateAfter*` helpers take (kept narrow so tests can pass a fake). */
export type InvalidatingClient = Pick<QueryClient, 'invalidateQueries'>
