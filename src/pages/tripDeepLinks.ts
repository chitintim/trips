/**
 * `?open=` deep-link targets for TripDetail — a small sibling to the
 * existing `?tab=`/LEGACY_TAB_TO_SPACE handling, for links that need to
 * land on a specific SHEET rather than just a space (e.g. an action note
 * saying "fill in your flights" should open the travel-details sheet, not
 * just the People space). Pulled out as a pure function so the mapping is
 * unit-testable without mounting TripDetail (which needs a full router +
 * query-client tree).
 */
export type OpenParamTarget =
  | { kind: 'travel-details' }
  | { kind: 'actions'; segment: 'actions' | 'bring' }

/** Resolves a raw `?open=` value to the sheet it should open, or `null` for an absent/unrecognized value. */
export function resolveOpenParam(value: string | null): OpenParamTarget | null {
  switch (value) {
    case 'travel-details':
      return { kind: 'travel-details' }
    case 'actions':
      return { kind: 'actions', segment: 'actions' }
    case 'actions-bring':
      return { kind: 'actions', segment: 'bring' }
    default:
      return null
  }
}
