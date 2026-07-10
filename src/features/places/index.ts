// Public surface of the places & maps feature (workstream F). Other
// features should only import from this barrel, not from
// src/features/places/** internals directly.
//
// NOTE: the legacy `TripMapTab`/`tripMapTabConfig` (a standalone map tab)
// were removed — TripDetail's v2.1 four-space nav (UX_REDESIGN.md) never
// mapped any space to it (see LEGACY_TAB_TO_SPACE in
// src/pages/TripDetail.tsx, which routes the old ?tab=map deep link
// straight to 'plan'), so it was unreachable dead code. The live map
// surface is the Plan space's Map lens
// (src/features/plan/components/PlanMapLens.tsx), which already
// lazy-loads its own react-leaflet chunk independently (see PlanTab.tsx's
// LazyPlanMapLens) — the lazy-boundary rationale below still applies to
// PlaceMapThumb, just no longer references TripMapTab as a second example.

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
// (~2.7MB) — re-exporting it here would drag leaflet into the main chunk,
// because this barrel itself is imported eagerly by many other features for
// PlaceChip/PlacePicker/etc. Its one consumer (RetrospectivePanel, already
// lazy-loaded as a whole chunk) imports it directly from
// './components/PlaceMapThumb' instead. If a second, non-lazy consumer ever
// needs it, reconsider this exception (e.g. lazy-wrap it too).
export type { PlaceMapThumbProps } from './components/PlaceMapThumb'

// Leaflet bootstrap + emoji divIcon builder, needed by any feature that
// renders its own react-leaflet map (e.g. plan's Map lens) rather than
// reusing a shared map component wholesale. Re-exporting here is safe re:
// bundle size because these are plain functions (no react-leaflet JSX
// import), unlike PlaceMapThumb above.
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
