import type { Place } from '../../../lib/queries/usePlaces'

/**
 * Places that exist on the trip but have no coordinates yet (created via
 * PlacePicker's "Name only" mode, or a link paste that couldn't resolve a
 * lat/lng). These never render as pins anywhere a map is drawn — this
 * selector is the shared source of truth for surfacing them so a fix-up UI
 * (PlanMapLens's "N places aren't on the map yet" section) can list them.
 * Pulled out as a pure function so it's unit-testable without mounting the
 * lens.
 */
export function placesWithoutCoordinates(places: Place[] | undefined): Place[] {
  return (places ?? []).filter((place) => place.lat == null || place.lng == null)
}
