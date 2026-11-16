/**
 * Pure state machine for the public /confirm-payment page. The page talks to
 * the `payment-confirm` edge function. Every call is a POST with the token in the
 * body (never in a URL): action 'peek' describes the payment and changes nothing,
 * 'confirm' / 'not_received' act. All answer HTTP 200 with `{ state, payment? }`.
 */

export type ServerState = 'valid' | 'confirmed' | 'disputed' | 'asked_again' | 'retracted' | 'expired' | 'changed' | 'invalid'

/** The answer the email link hinted at (`a=yes|no`). Only a UI hint: the server never trusts it. */
export type Answer = 'yes' | 'no'

export interface PaymentSummary {
  payerName: string
  /** Whose payment this is (the person the link was sent to), so a forwarded email is obvious. */
  receiverName: string
  amount: number
  currency: string
  /** Amount already formatted by the server, e.g. "£105.11". */
  formatted: string
  tripName: string
  tripId: string
  note: string | null
  /** For the 'check the payment in the app' link. */
  settlementId?: string
}

export interface ServerReply {
  state: ServerState
  payment?: PaymentSummary
}

export type PageState =
  | { kind: 'loading' }
  | { kind: 'valid'; payment: PaymentSummary; /** Pre-selected answer from the link, or null = show both buttons. */ answer: Answer | null; posting: 'confirm' | 'not_received' | null }
  | { kind: 'done'; result: 'confirmed' | 'disputed'; payment: PaymentSummary | null }
  | { kind: 'dead'; reason: 'expired' | 'changed' | 'invalid' | 'no_token'; payment: PaymentSummary | null }
  /** Read-only current truth shown when an old link is opened again. */
  | { kind: 'status'; reason: 'disputed' | 'asked_again' | 'retracted'; payment: PaymentSummary | null }
  | { kind: 'rate_limited' }
  | { kind: 'error'; retry: 'load' | 'post' }

const STATES: ServerState[] = ['valid', 'confirmed', 'disputed', 'asked_again', 'retracted', 'expired', 'changed', 'invalid']

/** `a` from the link: only exactly 'yes' or 'no' count; anything else is no hint. */
export function parseAnswerHint(value: string | null | undefined): Answer | null {
  return value === 'yes' || value === 'no' ? value : null
}

/** Reads an untrusted JSON body; anything unexpected is treated as "invalid". */
export function parseServerReply(body: unknown): ServerReply {
  if (!body || typeof body !== 'object') return { state: 'invalid' }
  const b = body as Record<string, unknown>
  const state = STATES.find((s) => s === b.state) ?? 'invalid'
  const p = b.payment
  if (p && typeof p === 'object') {
    const x = p as Record<string, unknown>
    if (typeof x.payerName === 'string' && typeof x.receiverName === 'string' && typeof x.formatted === 'string' && typeof x.tripName === 'string' && typeof x.tripId === 'string') {
      return {
        state,
        payment: {
          payerName: x.payerName,
          receiverName: x.receiverName,
          amount: typeof x.amount === 'number' ? x.amount : 0,
          currency: typeof x.currency === 'string' ? x.currency : '',
          formatted: x.formatted,
          tripName: x.tripName,
          tripId: x.tripId,
          note: typeof x.note === 'string' && x.note.trim() ? x.note : null,
          ...(typeof x.settlementId === 'string' && x.settlementId ? { settlementId: x.settlementId } : {}),
        },
      }
    }
  }
  return { state }
}

/**
 * Maps a reply to what the page shows. `hint` pre-selects an answer on a valid link; `from` says whether
 * the reply answers a button press ('post': disputed means "we've told them") or a plain look ('peek':
 * disputed means "you already told them").
 */
export function stateFromReply(reply: ServerReply, hint: Answer | null = null, from: 'peek' | 'post' = 'peek'): PageState {
  const payment = reply.payment ?? null
  switch (reply.state) {
    case 'valid':
      return payment ? { kind: 'valid', payment, answer: hint, posting: null } : { kind: 'dead', reason: 'invalid', payment: null }
    case 'confirmed':
      return { kind: 'done', result: 'confirmed', payment }
    case 'disputed':
      return from === 'post' ? { kind: 'done', result: 'disputed', payment } : { kind: 'status', reason: 'disputed', payment }
    case 'asked_again':
    case 'retracted':
      return { kind: 'status', reason: reply.state, payment }
    case 'expired':
    case 'changed':
    case 'invalid':
      return { kind: 'dead', reason: reply.state, payment }
  }
}

/** HTTP status -> page state for a failed call (non-200). */
export function stateFromHttpFailure(status: number | null, during: 'load' | 'post'): PageState {
  if (status === 429) return { kind: 'rate_limited' }
  if (status === 400) return { kind: 'dead', reason: 'invalid', payment: null } // a malformed token
  return { kind: 'error', retry: during }
}

/** A click is accepted only from the idle "valid" state, so a double tap cannot post twice. */
export function canPost(state: PageState): boolean {
  return state.kind === 'valid' && state.posting === null
}

/** "Change my answer": flips the pre-selected choice. Ignored while posting or when both buttons are shown. */
export function changeAnswer(state: PageState): PageState {
  if (!canPost(state) || state.kind !== 'valid' || state.answer === null) return state
  return { ...state, answer: state.answer === 'yes' ? 'no' : 'yes' }
}

/** Opening with no token at all. */
export const NO_TOKEN_STATE: PageState = { kind: 'dead', reason: 'no_token', payment: null }

export function startPosting(state: PageState, action: 'confirm' | 'not_received'): PageState {
  return canPost(state) && state.kind === 'valid' ? { ...state, posting: action } : state
}

export const COPY = {
  loading: 'Checking this payment…',
  expired: 'This link has expired. Open the trip to confirm it there.',
  changed: 'This payment has changed since the email was sent. Open the trip to see where it stands.',
  invalid: "This link isn't valid.",
  noToken: 'This link is missing its code — open the email again or open the app.',
  openApp: "Open Tim's Trip Planner",
  askedAgain: (payer: string) => `${payer} says they've sent it — check again.`,
  askedAgainHelp: "We've emailed you a new link, or open the payment in the app.",
  openPayment: 'Open this payment in the app',
  // Neutral on purpose: the payer or an organizer may have moved it back, and the link cannot tell which.
  retracted: (payer: string) => `${payer}'s payment is no longer marked as paid.`,
  told: (payer: string) => `You told ${payer} it hasn't arrived.`,
  toldHelp: (payer: string) => `We're waiting for ${payer} to respond. If it turns up, you can still confirm it in the app.`,
  yesButton: (p: PaymentSummary) => `Yes, I received ${p.formatted} from ${p.payerName}`,
  noButton: (p: PaymentSummary) => `Tell ${p.payerName} it hasn't arrived`,
  changeAnswer: 'Change my answer',
  rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
  error: "Something went wrong. Check your connection and try again.",
  confirmedLine: (payer: string) => `Thanks, you've confirmed it. ${payer} will see it's received.`,
  // True because payment-confirm emails the payer (same gates as the other notices) and the organizers
  // see it in Settle up. Do not change this line without changing both.
  disputedLine: (payer: string) => `Thanks. We've told ${payer}.`,
  forLine: (receiver: string) => `For ${receiver}`,
  checkFirst: 'Check the money has arrived before you confirm.',
  headline: (p: PaymentSummary) => `${p.payerName} says they paid you ${p.formatted} for ${p.tripName}`,
  openTrip: (tripName: string) => `Open ${tripName}`,
} as const
