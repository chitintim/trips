/**
 * `?open=` deep-link targets, re-implemented tiny from src/pages/tripDeepLinks.ts
 * (resolveOpenParam / formatOpenParam). The assistant never writes a URL: the
 * client builds the link from `open_param`, and that value is built here ONLY
 * from this table, with every id verified to exist on the trip by openScreen.ts.
 */

/** Targets with no id: `?open=<kind>`. */
export const BARE_TARGETS = ['todos', 'rsvp', 'answer-all', 'settle', 'travel-details', 'setup', 'actions', 'actions-bring'] as const

/** Targets with an id: `?open=<kind>:<id>`. */
export const ID_TARGETS = ['question', 'todo', 'bring', 'payment', 'item', 'claim', 'decide', 'book'] as const

export type BareTarget = (typeof BARE_TARGETS)[number]
export type IdTarget = (typeof ID_TARGETS)[number]
export type OpenTargetName = BareTarget | IdTarget

export const OPEN_TARGETS: readonly OpenTargetName[] = [...BARE_TARGETS, ...ID_TARGETS]

export function isIdTarget(t: string): t is IdTarget {
  return (ID_TARGETS as readonly string[]).includes(t)
}

export function isBareTarget(t: string): t is BareTarget {
  return (BARE_TARGETS as readonly string[]).includes(t)
}

/** The exact `?open=` value. */
export function formatOpenParam(target: OpenTargetName, id: string | null): string {
  return isIdTarget(target) ? `${target}:${id}` : target
}

/** Plain-words button labels. No trip text in them. */
export const TARGET_LABELS: Record<OpenTargetName, string> = {
  todos: 'Open your to-dos',
  rsvp: 'Open the "Are you coming?" reply',
  'answer-all': 'Answer the open questions',
  settle: 'Open Settle up',
  'travel-details': 'Open travel details',
  setup: 'Open trip setup',
  actions: 'Open the to-dos',
  'actions-bring': 'Open the bring list',
  question: 'Open the question',
  todo: 'Open the to-do',
  bring: 'Open the bring item',
  payment: 'Open the payment',
  item: 'Open the plan item',
  claim: 'Open "Who had what"',
  decide: 'Open Decide',
  book: 'Open Mark booked',
}
