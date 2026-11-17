import { RELOAD_WRITE_MESSAGE, USE_RPC_WRITE_MESSAGE } from '../../../lib/writeRefusals'

/**
 * Plain-language messages for the receipt-claims functions. The server answers
 * with a SQLSTATE `code` and a short `hint`; the raw message can be technical.
 */
const BY_HINT: Record<string, string> = {
  forbidden: 'You can add yourself to an item and keep everyone already on it, or take yourself off it. The payer or an organizer can change anything else.',
  frozen: 'Balances are frozen. Ask an organizer to unfreeze them before changing who had what.',
  not_tagged: "Someone you picked isn't on this receipt.",
  not_itemised: "This expense isn't itemised.",
  bad_line: "That item isn't on this receipt any more. Refresh and try again.",
  not_found: "This receipt can't be found any more.",
  auth: 'Please sign in again.',
  reload: RELOAD_WRITE_MESSAGE,
  use_rpc: USE_RPC_WRITE_MESSAGE,
  claims_closed: "This receipt's claims are closed, so they can't be changed. The person who paid can reopen it.",
}

export function describeClaimError(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err && typeof err === 'object') {
    const { hint, code, message } = err as { hint?: unknown; code?: unknown; message?: unknown }
    if (typeof hint === 'string' && BY_HINT[hint]) return BY_HINT[hint]
    if (code === '55P03') return 'The trip is busy right now. Try again in a moment.'
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

/**
 * The own-claims function (`set_my_receipt_claims`) has its own reasons; where a hint means something different there than for the
 * payer's "who had what" function (`forbidden`), this wins. Everything else falls through to `describeClaimError`.
 */
const OWN_BY_HINT: Record<string, string> = {
  forbidden: "You're not on this receipt. Ask the person who paid.",
  frozen: 'Balances are frozen. An organizer can unfreeze them in Settle up.',
  claims_closed: 'The rest of this receipt has already been shared. Ask the person who paid to reopen it.',
  currency_unsupported: "Receipts in this currency can't be split here yet.",
  bad_input: 'Something went wrong. Reload and try again.',
  bad_line: 'Something went wrong. Reload and try again.',
  table_item: 'Everyone shares this item; the person who paid changes it.',
  fixed_share: 'Your part of this item is a shared share. Change it with the share picker.',
  overclaimed: "There isn't that much of this item left.",
  not_found: 'This expense no longer exists.',
}

/** Message for a refused `set_my_receipt_claims` save (never empty). */
export function describeOwnClaimError(err: unknown): string {
  const hint = err && typeof err === 'object' ? (err as { hint?: unknown }).hint : null
  if (typeof hint === 'string' && OWN_BY_HINT[hint]) return OWN_BY_HINT[hint]
  return describeClaimError(err)
}
