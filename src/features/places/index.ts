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

export { PlaceMapThumb } from './components/PlaceMapThumb'
export type { PlaceMapThumbProps } from './components/PlaceMapThumb'

export { TripMapTab } from './TripMapTab'
export type { TripMapTabProps } from './TripMapTab'

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
 */
import type { ComponentType } from 'react'
import { TripMapTab, type TripMapTabProps } from './TripMapTab'

export const tripMapTabConfig: {
  tabId: 'map'
  label: string
  icon: string
  Component: ComponentType<TripMapTabProps>
} = {
  tabId: 'map',
  label: 'Map',
  icon: '🗺️',
  Component: TripMapTab,
}
