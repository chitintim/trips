/**
 * Which claims a re-itemise clears, as a hint for the editor. The database
 * function `reitemize_expense` is the authority; this mirrors its rule so the
 * warning matches (and so the editor can warn before the function exists).
 *
 * A saved line is UNCHANGED, and its claims survive, when the editor carried
 * its id and all of these still hold:
 *  - the trimmed name is the same;
 *  - the quantity is the same to 2 decimal places;
 *  - the subtotal (the item price) is the same in the currency's minor units;
 *  - the currency has not changed.
 * The line total MAY differ (tax, service, tip and discount are re-shared and
 * the claim money follows). Anything else with an id is CHANGED: its claims are
 * cleared. A saved line the editor no longer has is removed with its claims.
 * An id is honoured once: a second line carrying it counts as a new line.
 */
import { toMinorUnits } from '../../../lib/money'

export interface ExistingLineForDiff {
  id: string
  name_original: string
  quantity: number
  /** The item price before tax and service. */
  subtotal: number
}

export interface ExistingClaimForDiff {
  line_item_id: string
  user_id: string
  quantity_claimed: number
}

export interface NewLineForDiff {
  name_original: string
  quantity: number
  subtotal: number
  /** Id of the saved line this one continues, when the editor knows. */
  keepFromLineItemId: string | null
}

export interface ReitemiseDiff {
  /** Same order as the new lines. `lineItemId` is the saved row it continues (null = brand new); `unchanged` = its claims survive. */
  decisions: Array<{ lineItemId: string | null; unchanged: boolean }>
  /** Distinct people whose claims are cleared. */
  clearedUserIds: string[]
  clearedClaimCount: number
  keptClaimCount: number
  /** Saved lines that are removed (their claims go with them). */
  discardedLineIds: string[]
}

const sameName = (a: string, b: string) => a.trim() === b.trim()
const sameQty = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100)

export function diffReitemise(args: {
  existingLines: ExistingLineForDiff[]
  existingClaims: ExistingClaimForDiff[]
  newLines: NewLineForDiff[]
  currency: string
  /** The saved expense's currency, when it may differ from `currency`; a change leaves nothing unchanged. */
  previousCurrency?: string
}): ReitemiseDiff {
  const { existingLines, existingClaims, newLines, currency, previousCurrency } = args
  const currencyChanged = !!previousCurrency && previousCurrency !== currency
  const byId = new Map(existingLines.map((l) => [l.id, l]))
  const taken = new Set<string>()

  const decisions = newLines.map((n) => {
    const id = n.keepFromLineItemId
    const e = id ? byId.get(id) : undefined
    if (!id || !e || taken.has(id)) return { lineItemId: null, unchanged: false }
    taken.add(id)
    const unchanged =
      !currencyChanged &&
      sameName(e.name_original, n.name_original) &&
      sameQty(e.quantity, n.quantity) &&
      toMinorUnits(e.subtotal, currency) === toMinorUnits(n.subtotal, currency)
    return { lineItemId: id, unchanged }
  })

  const unchangedIds = new Set(decisions.filter((d) => d.unchanged && d.lineItemId).map((d) => d.lineItemId as string))
  const discardedLineIds = existingLines.filter((l) => !taken.has(l.id)).map((l) => l.id)
  const cleared = existingClaims.filter((c) => !unchangedIds.has(c.line_item_id))

  return {
    decisions,
    clearedUserIds: [...new Set(cleared.map((c) => c.user_id))],
    clearedClaimCount: cleared.length,
    keptClaimCount: existingClaims.length - cleared.length,
    discardedLineIds,
  }
}

const listNames = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * The confirm text. `names` are the people whose claims go.
 *  - Default ("changed items" scope): "2 people's claims will be cleared: Sam and Alex."
 *  - `all`: used when the database function is not there yet, so EVERY claim on
 *    the receipt is cleared, not just those on changed items.
 */
export function clearedClaimsWarningText(
  names: string[],
  opts: { all?: boolean; claimCount?: number; leftoversCleared?: boolean; reconfirmCount?: number } = {}
): string {
  const n = names.length
  const who = n === 1 ? "1 person's claim" : `${n} people's claims`
  const parts: string[] = []
  if (n === 0 && !opts.all) {
    // Nobody's items go; only the people who already said "That's everything" are affected.
  } else if (opts.all) {
    const claims = opts.claimCount ?? n
    parts.push(`All claims on this receipt will be cleared: ${claims === 1 ? '1 claim' : `${claims} claims`} from ${listNames(names)}.`)
    parts.push('They will need to choose their items again.')
  } else {
    parts.push(`${who} will be cleared: ${listNames(names)}.`)
    parts.push('Claims on items you did not change are kept.')
  }
  const r = opts.reconfirmCount ?? 0
  if (r > 0) parts.push(`${r} ${r === 1 ? 'person who said' : 'people who said'} "That's everything" will be asked to check again.`)
  if (opts.leftoversCleared) parts.push('Shared leftovers are reset too.')
  return parts.join(' ')
}
