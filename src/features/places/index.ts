// Public surface of the places & maps feature (workstream F). Other
// features should only import from this barrel, not from
// src/features/places/** internals directly.

// Pure lib helpers (no React) — also directly importable from
// src/lib/places/* since they have no feature-local dependencies, but
// re-exported here for convenience/discoverability alongside components.
export { parseGoogleMapsLink } from '../../lib/places/parseGoogleMapsLink'
export type { ParsedGoogleMapsLink } from '../../lib/places/parseGoogleMapsLink'
export { searchPlace, geocodeAndCreatePlace } from '../../lib/places/geocode'
export type { GeocodeResult, NominatimResult } from '../../lib/places/geocode'

export { PlaceChip, googleMapsPlaceUrl, googleMapsDirectionsUrl } from './components/PlaceChip'
export type { PlaceChipProps, PlaceLike } from './components/PlaceChip'

export { PlacePicker } from './components/PlacePicker'
export type { PlacePickerProps } from './components/PlacePicker'

// NOTE: `PlaceMapThumb` is deliberately NOT re-exported from this barrel
// (unlike PlaceChip/PlacePicker above). It pulls in `react-leaflet`/`leaflet`
// (~2.7MB) just like TripMapTab -- re-exporting it here would defeat
// TripMapTab's lazy-loading below, because this barrel itself is imported
// eagerly by many other features for PlaceChip/PlacePicker/etc., which would
// drag leaflet back into the main chunk. Its one consumer
// (RetrospectivePanel, already lazy-loaded as a whole chunk) imports it
// directly from './components/PlaceMapThumb' instead. If a second, non-lazy
// consumer ever needs it, reconsider this exception (e.g. lazy-wrap it too).
export type { PlaceMapThumbProps } from './components/PlaceMapThumb'

export type { TripMapTabProps } from './TripMapTab'
// NOTE: `dayIndexFor` (TripMapTab's local day-index helper) is deliberately
// NOT re-exported here: TripMapTab.tsx is lazy-loaded by this barrel (see
// tripMapTabConfig below) specifically to keep leaflet/react-leaflet out of
// the main chunk, and a `export { x } from './TripMapTab'` line is a
// *static* import that would defeat that lazy boundary (Vite warns "also
// statically imported"). Consumers needing day-index math re-derive the
// same one-line calc locally (see src/features/plan/components/PlanMapLens.tsx).

// Leaflet bootstrap + emoji divIcon builder, needed by any feature that
// renders its own react-leaflet map (e.g. plan's Map lens) rather than
// reusing TripMapTab wholesale. Re-exporting here is safe re: bundle size
// because these are plain functions (no react-leaflet JSX import), unlike
// PlaceMapThumb/TripMapTab above.
export { ensureLeafletDefaultIcon, emojiDivIcon } from './lib/leafletSetup'

// Marker/color helpers, exposed in case other features want visually
// consistent day-coloring or category emoji (e.g. a timeline day legend).
export {
  DAY_COLORS,
  colorForDayIndex,
  timelineCategoryEmoji,
  OPTION_MARKER_COLOR,
  OPTION_MARKER_EMOJI,
  EXPENSE_MARKER_COLOR,
  EXPENSE_MARKER_EMOJI,
} from './lib/mapMarkers'

/**
 * Trip-level tab config for this feature, ready for the coordinator to
 * splice into TripDetail.tsx's tab list. `Component` takes the minimal
 * `{ tripId, tripStartDate? }` props TripMapTab needs — the coordinator
 * supplies `trip.id` / `trip.start_date` at the call site.
 *
 * `TripMapTab` (and its leaflet/react-leaflet dependency, ~2.7MB) is loaded
 * via React.lazy so the map tab's JS is only fetched when a user actually
 * opens the Map tab (WSH perf pass, plan §16/code-splitting target) — the
 * coordinator wraps `Component` in a `<Suspense>` with a skeleton fallback.
 */
import { lazy, type ComponentType } from 'react'
import type { TripMapTabProps } from './TripMapTab'

export const tripMapTabConfig: {
  tabId: 'map'
  label: string
  icon: string
  Component: ComponentType<TripMapTabProps>
} = {
  tabId: 'map',
  label: 'Map',
  icon: '🗺️',
  Component: lazy(() => import('./TripMapTab').then((m) => ({ default: m.TripMapTab }))),
}
