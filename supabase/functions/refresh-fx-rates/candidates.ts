// Which expenses the nightly job may re-rate. Pure, so it is unit tested.
//
// A trip is FROZEN while people settle up (trips.settlement_snapshot is not
// null). Its balances must never move, so this job skips every expense of a
// frozen trip: it runs as the service role and would otherwise rewrite
// fx_rate / base_currency_amount (and the splits) behind the snapshot.

export interface FxCandidateRow {
  id: string
  rate_source?: string | null
  fx_rate_date?: string | null
  payment_date: string
  // PostgREST returns an embedded to-one relation as an object (or, from some
  // client versions, a one-element array); accept both.
  trips?: TripEmbed | TripEmbed[] | null
}

interface TripEmbed {
  base_currency?: string | null
  settlement_snapshot?: unknown
}

export function tripOf(row: Pick<FxCandidateRow, 'trips'>): TripEmbed | null {
  const t = row.trips
  return Array.isArray(t) ? (t[0] ?? null) : (t ?? null)
}

/** True when the expense's trip has a settlement snapshot. A missing trip counts as frozen (fail safe). */
export function isFrozenRow(row: Pick<FxCandidateRow, 'trips'>): boolean {
  const trip = tripOf(row)
  if (!trip) return true
  return trip.settlement_snapshot !== null && trip.settlement_snapshot !== undefined
}

export function selectFxCandidates<T extends FxCandidateRow>(rows: T[]): { candidates: T[]; skippedFrozen: number } {
  let skippedFrozen = 0
  const candidates: T[] = []
  for (const e of rows) {
    if (
      e.rate_source !== 'manual' && // never clobber a user-overridden rate (plan §11)
      e.fx_rate_date &&
      e.fx_rate_date < e.payment_date
    ) {
      if (isFrozenRow(e)) {
        skippedFrozen++
        continue
      }
      candidates.push(e)
    }
  }
  return { candidates, skippedFrozen }
}
