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
