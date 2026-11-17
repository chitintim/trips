/**
 * Pure state machine for the public /receipt page. The page talks to the `receipt-claim` edge function:
 * every call is a POST with the token in the body. 'peek' describes the receipt and changes nothing; 'done',
 * 'not_there', 'undo_done' and 'toggle' act and are only ever sent from a visible tap.
 */

export type Action = 'done' | 'not_there' | 'undo_done' | 'toggle'
/** The answer the link hinted at (`a=done|not_there`). Only a pre-selection: nothing is sent until a button is tapped. */
export type Hint = 'done' | 'not_there'

export interface MyItem {
  lineItemId: string
  name: string
  total: number
  myAmount: number
  leftoverAmount: number
  /** First names of the other people on the item. */
  others: string[]
  sharedByAll: boolean
  canToggle: boolean
}

export interface AvailableItem {
  lineItemId: string
  name: string
  total: number
  others: string[]
}

export interface ReceiptView {
  tripId: string
  tripName: string
  expenseId: string
  title: string
  currency: string
  payerFirstName: string
  meFirstName: string
  meIsPayer: boolean
  onReceipt: boolean
  response: 'done' | 'not_there' | null
  deadline: string | null
  closedAt: string | null
  frozen: boolean
  editable: boolean
  closedReason: string | null
  myItems: MyItem[]
  availableItems: AvailableItem[]
  myTotal: number
  myLeftoverTotal: number
}

export type PageState =
  | { kind: 'loading' }
  | { kind: 'ready'; receipt: ReceiptView; hint: Hint | null; posting: Action | null; notice: string | null }
  | { kind: 'dead'; reason: 'expired' | 'revoked' | 'invalid' | 'no_token' }
  | { kind: 'unavailable' }
  | { kind: 'rate_limited' }
  | { kind: 'error'; retry: 'load' }

export type ReplyState = 'ok' | 'refused' | 'expired' | 'revoked' | 'invalid' | 'unavailable'
export interface ServerReply {
  state: ReplyState
  receipt?: ReceiptView
  reason?: string
}

const STATES: ReplyState[] = ['ok', 'refused', 'expired', 'revoked', 'invalid', 'unavailable']

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const itemName = (x: Record<string, unknown>): string => str(x.name_english) || str(x.name)

/** Reads the untrusted `receipt` payload; null when it is not usable. */
export function parseReceipt(raw: unknown): ReceiptView | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const expense = obj(r.expense)
  const me = obj(r.me)
  if (!str(expense.id) || !str(expense.trip_id)) return null
  const rows = (v: unknown) => (Array.isArray(v) ? v.map(obj).filter((x) => str(x.line_item_id)) : [])
  return {
    tripId: str(expense.trip_id),
    tripName: str(expense.trip_name),
    expenseId: str(expense.id),
    title: str(expense.title),
    currency: str(expense.currency),
    payerFirstName: str(expense.payer_first_name) || 'The payer',
    meFirstName: str(me.first_name),
    meIsPayer: me.is_payer === true,
    onReceipt: r.on_receipt !== false,
    response: r.response === 'done' || r.response === 'not_there' ? r.response : null,
    deadline: str(r.deadline) || null,
    closedAt: str(r.closed_at) || null,
    frozen: r.frozen === true,
    editable: r.editable === true,
    closedReason: str(r.closed_reason) || null,
    myItems: rows(r.my_items).map((x) => ({
      lineItemId: str(x.line_item_id),
      name: itemName(x),
      total: num(x.total),
      myAmount: num(x.my_amount),
      leftoverAmount: num(x.leftover_amount),
      others: names(x.others),
      sharedByAll: x.shared_by_all === true,
      canToggle: x.can_toggle === true,
    })),
    availableItems: rows(r.available_items).map((x) => ({ lineItemId: str(x.line_item_id), name: itemName(x), total: num(x.total), others: names(x.others) })),
    myTotal: num(r.my_total),
    myLeftoverTotal: num(r.my_leftover_total),
  }
}

/** Reads an untrusted JSON body; anything unexpected is "invalid". */
export function parseServerReply(body: unknown): ServerReply {
  if (!body || typeof body !== 'object') return { state: 'invalid' }
  const b = body as Record<string, unknown>
  const state = STATES.find((s) => s === b.state) ?? 'invalid'
  if (state === 'ok' || state === 'refused') {
    const receipt = parseReceipt(b.receipt)
    if (!receipt) return { state: 'invalid' }
    return { state, receipt, ...(typeof b.reason === 'string' ? { reason: b.reason } : {}) }
  }
  return { state }
}

/** Why a tap was refused, in plain words. The server's own `message` is not shown, so the wording stays ours. */
export const REFUSED_COPY: Record<string, string> = {
  frozen: "The trip's balances are frozen, so this can't be changed any more.",
  claims_closed: 'This receipt has been closed.',
  closed: 'This receipt has been closed.',
  deadline_passed: 'The time to reply has passed.',
  not_open: "This receipt isn't open for replies.",
  not_itemised: "This receipt isn't split by item.",
  not_on_receipt: "You aren't on this receipt.",
  payer: "You paid for this, so you can't say you weren't there.",
  has_claims: "You've got items on this receipt, so take them off first.",
  has_leftovers: 'You were chosen to cover the leftovers on this receipt. Ask the person who paid to change that first.',
  too_many_sharers: "That item can't be shared with any more people.",
}
export const REFUSED_FALLBACK = "That didn't go through. Nothing was changed."

export function refusedNotice(reason: string | undefined, payerFirstName?: string): string {
  if (reason === 'has_leftovers') {
    return payerFirstName && payerFirstName !== 'The payer'
      ? `You were chosen to cover the leftovers on this receipt. Ask ${payerFirstName} to change that first.`
      : REFUSED_COPY.has_leftovers
  }
  return (reason && REFUSED_COPY[reason]) || REFUSED_FALLBACK
}

/** Maps a reply to what the page shows. `hint` pre-selects an answer (only on a plain look, never after a tap). */
export function stateFromReply(reply: ServerReply, hint: Hint | null = null): PageState {
  switch (reply.state) {
    case 'ok':
      return reply.receipt ? { kind: 'ready', receipt: reply.receipt, hint, posting: null, notice: null } : { kind: 'dead', reason: 'invalid' }
    case 'refused':
      return reply.receipt ? { kind: 'ready', receipt: reply.receipt, hint: null, posting: null, notice: refusedNotice(reply.reason, reply.receipt.payerFirstName) } : { kind: 'dead', reason: 'invalid' }
    case 'unavailable':
      return { kind: 'unavailable' }
    default:
      return { kind: 'dead', reason: reply.state }
  }
}

/** HTTP status -> page state for a failed call. 503 (and an old 409 `not_available`) = the feature is not switched on yet. */
export function stateFromHttpFailure(status: number | null): PageState {
  if (status === 429) return { kind: 'rate_limited' }
  if (status === 503 || status === 409) return { kind: 'unavailable' }
  if (status === 400 || status === 403 || status === 405) return { kind: 'dead', reason: 'invalid' }
  return { kind: 'error', retry: 'load' }
}

export const NO_TOKEN_STATE: PageState = { kind: 'dead', reason: 'no_token' }

/** A tap is accepted only from the idle ready state, so a double tap cannot post twice. */
export function canPost(state: PageState): boolean {
  return state.kind === 'ready' && state.posting === null
}

export function startPosting(state: PageState, action: Action): PageState {
  return canPost(state) && state.kind === 'ready' ? { ...state, posting: action, notice: null } : state
}

/** "Not this?": flips the pre-selected answer. Ignored while posting or when nothing is pre-selected. */
export function changeHint(state: PageState): PageState {
  if (!canPost(state) || state.kind !== 'ready' || state.hint === null) return state
  return { ...state, hint: state.hint === 'done' ? 'not_there' : 'done' }
}

export type ScreenKind = 'frozen' | 'closed' | 'read_only' | 'not_there' | 'done' | 'open'

/** Which screen the receipt gets. Closed and frozen win over the person's own answer. */
export function screenOf(r: ReceiptView): ScreenKind {
  if (r.frozen || r.closedReason === 'frozen') return 'frozen'
  if (r.closedAt || r.closedReason === 'claims_closed' || r.closedReason === 'closed') return 'closed'
  if (!r.editable) return 'read_only'
  if (!r.onReceipt || r.response === 'not_there') return 'not_there'
  if (r.response === 'done') return 'done'
  return 'open'
}

/** "÷3" when the item is shared with others (the person plus the others named). */
export function shareLabel(item: Pick<MyItem, 'others' | 'sharedByAll'>): string | null {
  const n = item.others.length + 1
  return n > 1 ? `÷${n}` : item.sharedByAll ? '÷ everyone' : null
}

export const COPY = {
  loading: 'Opening your receipt…',
  forLine: (name: string) => (name ? `For ${name}` : ''),
  headline: (payer: string, title: string) => `${payer} paid for ${title}`,
  putDown: (payer: string) => `${payer} put you down for:`,
  ownItems: 'Your items:',
  nothingYet: "Nothing is put down for you yet.",
  tickPrompt: 'Not put on you yet. Tick any that were yours:',
  total: 'Your share so far',
  done: "That's everything",
  notThere: "I wasn't there",
  undo: 'Undo',
  notYours: 'Not mine',
  notNow: 'Not this? Change my answer',
  doneThanks: (share: string) => `Thanks — you're done. Your share: ${share}`,
  notThereThanks: (payer: string) => `You told ${payer} you weren't there.`,
  closedLine: (share: string) => `This receipt is closed. Your final share: ${share}`,
  closedOn: (day: string) => `Closed on ${day}.`,
  leftoverNote: (amount: string) => `That includes ${amount} from the leftovers that were shared out.`,
  frozenLine: (share: string) => `The trip's balances are frozen, so this can't be changed any more. Your share: ${share}`,
  readOnly: "You can't change this any more.",
  expired: 'This link has expired. Open the trip to see this receipt there.',
  revoked: 'This link no longer works. Use the latest email you were sent, or open the trip.',
  invalid: "This link isn't valid.",
  noToken: 'This link is missing its code — open the email again or open the app.',
  unavailable: "This isn't available yet. Open the trip to see this receipt there.",
  rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
  error: 'Something went wrong. Check your connection and try again.',
  openApp: 'Open in the app',
  openAppGeneric: "Open Tim's Trip Planner",
} as const
