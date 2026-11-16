/**
 * Pure text helpers for PriceTag: the screen-reader sentence for a price.
 * No React, so it is unit tested without a DOM.
 */
import { CERTAINTY_WORD, type Certainty } from '../../lib/cost/optionPrice'

/** Spoken form of a printed money line: "≈£222 each" -> "about £222 each". */
export function speakable(text: string): string {
  return text.replace(/≈\s?/g, 'about ').replace(/\s·\s/g, ', ').replace(/\best\./g, 'estimate').replace(/\s+/g, ' ').trim()
}

const CERTAINTY_SPOKEN: Record<Certainty, string> = {
  est: 'estimate',
  decided: 'decided price',
  booked: 'booked price',
  paid: 'paid',
}

/** "about £222 each, £2,000 total, 9 invited, estimate". */
export function priceSpokenText(parts: { headline: string; basisLine?: string | null; sensitivityLine?: string | null; certainty?: Certainty }): string {
  const bits = [speakable(parts.headline)]
  if (parts.basisLine) bits.push(speakable(parts.basisLine))
  if (parts.sensitivityLine) bits.push(speakable(parts.sensitivityLine))
  // The basis line already ends in the certainty word; only add the spoken form when it is missing.
  const joined = bits.join('. ')
  if (parts.certainty && !parts.basisLine && !joined.includes(CERTAINTY_WORD[parts.certainty]) ) {
    return `${joined}, ${CERTAINTY_SPOKEN[parts.certainty]}`
  }
  return joined
}
