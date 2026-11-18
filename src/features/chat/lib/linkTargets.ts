import { resolveOpenParam, type OpenTarget } from '../../../pages/tripDeepLinks'

export interface LinkCopy {
  message: string
  button: string
}

const COPY: Partial<Record<OpenTarget['kind'], LinkCopy>> = {
  decide: { message: 'Deciding is done by an organizer on the question itself.', button: 'Open Decide' },
  book: { message: 'Marking something as booked is done by an organizer on the question itself.', button: 'Open Mark booked' },
  settle: { message: 'Settling up is done on the Settle up screen.', button: 'Open Settle up' },
  payment: { message: 'Payments are marked on their own screen.', button: 'Open the payment' },
  question: { message: 'The question has everything you need.', button: 'Open the question' },
  'answer-all': { message: 'Your open questions are all in one place.', button: 'Answer my questions' },
  todo: { message: 'You can see it with your to-dos.', button: 'Open the to-do' },
  bring: { message: 'You can see it with your to-dos.', button: 'Open the to-do' },
  todos: { message: 'Your to-dos are on Today.', button: 'Open my to-dos' },
  rsvp: { message: 'Your reply is changed on its own screen.', button: 'Open my reply' },
  'travel-details': { message: 'Travel details are added on their own screen.', button: 'Open travel details' },
  claim: { message: 'Who had what is sorted on the receipt.', button: 'Open the receipt' },
  item: { message: 'It is on the plan.', button: 'Open it' },
  setup: { message: 'Setting up is done on its own screen.', button: 'Open setup' },
}

export interface ResolvedLink {
  openParam: string
  copy: LinkCopy
}

/**
 * A link card is built only from a recognised in-app `?open=` target (the same table the emails and to-dos use).
 * Anything the app does not recognise yields null, so a card is never made from a model-written address.
 */
export function resolveLink(params: Record<string, unknown>): ResolvedLink | null {
  const raw = typeof params.open_param === 'string' ? params.open_param : null
  const target = resolveOpenParam(raw)
  if (!raw || !target) return null
  return { openParam: raw, copy: COPY[target.kind] ?? { message: 'It is done on its own screen.', button: 'Open it' } }
}

/** Link cards of one reply, each target once (the server may repeat a link; the person should see one button). */
export function dedupeLinkCards<T extends { kind: string; params: Record<string, unknown> }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter((a) => {
    if (a.kind !== 'open_screen') return true
    const key = typeof a.params.open_param === 'string' ? a.params.open_param : JSON.stringify(a.params)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
