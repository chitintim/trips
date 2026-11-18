import { resolveOpenParam, type OpenTarget } from '../../../pages/tripDeepLinks'

export interface LinkCopy {
  message: string
  button: string
}

/** What the button does, in a neutral line. It describes where the button goes; it never says what the person asked or why. */
const COPY: Partial<Record<OpenTarget['kind'], LinkCopy>> = {
  decide: { message: 'Opens the question.', button: 'Open Decide' },
  book: { message: 'Opens the question.', button: 'Open Mark booked' },
  settle: { message: 'Opens the Settle up screen.', button: 'Open Settle up' },
  payment: { message: 'Opens the payment.', button: 'Open the payment' },
  question: { message: 'Opens the question.', button: 'Open the question' },
  'answer-all': { message: 'Opens your open questions.', button: 'Answer my questions' },
  todo: { message: 'Opens the to-do.', button: 'Open the to-do' },
  bring: { message: 'Opens the to-do.', button: 'Open the to-do' },
  todos: { message: 'Opens your to-dos.', button: 'Open my to-dos' },
  rsvp: { message: 'Opens your reply.', button: 'Open my reply' },
  'travel-details': { message: 'Opens your travel details.', button: 'Open travel details' },
  claim: { message: 'Opens the receipt.', button: 'Open the receipt' },
  item: { message: 'Opens the item on the plan.', button: 'Open it' },
  setup: { message: 'Opens trip setup.', button: 'Open setup' },
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
  return { openParam: raw, copy: COPY[target.kind] ?? { message: 'Opens the screen.', button: 'Open it' } }
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

/**
 * Link cards are never stored on the server, so the only copy lives in client state and belongs to the turn that made it.
 * "New chat" and a change of trip drop them; they are also never "detached" (shown away from their own reply).
 */
export function withoutLinkCards<T extends { kind: string }>(known: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(known).filter(([, a]) => a.kind !== 'open_screen'))
}

/** Stored suggestions still waiting for a tap whose own reply is not on screen. Link cards are excluded: they show only under their own turn. */
export function detachedActions<T extends { kind: string; status: string; turn_id?: string | null }>(known: Record<string, T>, currentTurn: string | null, turnsWithMessage: ReadonlySet<string>): T[] {
  return Object.values(known).filter((a) => a.kind !== 'open_screen' && a.status === 'proposed' && a.turn_id !== currentTurn && !(a.turn_id && turnsWithMessage.has(a.turn_id)))
}
