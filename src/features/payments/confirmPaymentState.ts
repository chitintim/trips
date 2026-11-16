/**
 * Pure state machine for the public /confirm-payment page. The page talks to
 * the `payment-confirm` edge function. Every call is a POST with the token in the
 * body (never in a URL): action 'peek' describes the payment and changes nothing,
 * 'confirm' / 'not_received' act. All answer HTTP 200 with `{ state, payment? }`.
 */

export type ServerState = 'valid' | 'confirmed' | 'disputed' | 'expired' | 'changed' | 'invalid'

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
}

export interface ServerReply {
  state: ServerState
  payment?: PaymentSummary
}

export type PageState =
  | { kind: 'loading' }
  | { kind: 'valid'; payment: PaymentSummary; posting: 'confirm' | 'not_received' | null }
  | { kind: 'done'; result: 'confirmed' | 'disputed'; payment: PaymentSummary | null }
  | { kind: 'dead'; reason: 'expired' | 'changed' | 'invalid'; payment: PaymentSummary | null }
  | { kind: 'rate_limited' }
  | { kind: 'error'; retry: 'load' | 'post' }

const STATES: ServerState[] = ['valid', 'confirmed', 'disputed', 'expired', 'changed', 'invalid']

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
        },
      }
    }
  }
  return { state }
}

/** Maps a reply (from GET or POST) to what the page shows. */
export function stateFromReply(reply: ServerReply): PageState {
  const payment = reply.payment ?? null
  switch (reply.state) {
    case 'valid':
      return payment ? { kind: 'valid', payment, posting: null } : { kind: 'dead', reason: 'invalid', payment: null }
    case 'confirmed':
    case 'disputed':
      return { kind: 'done', result: reply.state, payment }
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

export function startPosting(state: PageState, action: 'confirm' | 'not_received'): PageState {
  return canPost(state) && state.kind === 'valid' ? { ...state, posting: action } : state
}

export const COPY = {
  loading: 'Checking this payment…',
  expired: 'This link has expired. Open the trip to confirm it there.',
  changed: 'This payment has changed since the email was sent. Open the trip to see where it stands.',
  invalid: "This link isn't valid.",
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
