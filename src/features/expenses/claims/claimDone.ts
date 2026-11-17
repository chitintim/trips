/**
 * Leaving "Who had what" with "Done": the question to ask when items are still unassigned, and where Done goes.
 * Pure so the wording is tested.
 */
import { formatMoneyMinor } from '../lib/formatMoney'

export const SORT_OUT_THE_REST = 'Sort out the rest'
export const LEAVE_IT_FOR_NOW = 'Leave it for now'

export interface UnassignedPrompt {
  title: string
  body: string
}

/** "1 item (£4.00) isn't assigned yet" plus who it sits with meanwhile; null when nothing is left. */
export function unassignedPrompt(args: { count: number; minor: number; currency: string; payerName: string; viewerIsPayer: boolean }): UnassignedPrompt | null {
  const { count, minor, currency, payerName, viewerIsPayer } = args
  if (count <= 0) return null
  const amount = formatMoneyMinor(minor, currency)
  const title = count === 1 ? `1 item (${amount}) isn't assigned yet` : `${count} items (${amount}) aren't assigned yet`
  const owner = viewerIsPayer ? 'you' : payerName
  return { title, body: `Until ${count === 1 ? 'it is' : 'they are'} placed, ${count === 1 ? 'it stays' : 'they stay'} with ${owner}.` }
}

/** Where Done goes: the trip's Money space (the trip page does not remember a space, so going "back" would land on Today). */
export function moneySpaceUrl(tripId: string): string {
  return `/${encodeURIComponent(tripId)}?tab=money`
}
