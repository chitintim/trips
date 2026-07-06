import type { Tables } from '../../../types/database.types'

export type PlaceLike = Pick<Tables<'places'>, 'name' | 'lat' | 'lng' | 'google_place_url' | 'google_maps_link'>

/**
 * Deep link to the place's Google Maps page. Prefers a stored place-page
 * URL (from link-parse), otherwise falls back to coordinates, otherwise a
 * name-only search — so this always works even for name-only places.
 */
export function googleMapsPlaceUrl(place: PlaceLike): string {
  if (place.google_place_url) return place.google_place_url
  if (place.google_maps_link) return place.google_maps_link
  if (place.lat != null && place.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}`
}

/**
 * Deep link that opens turn-by-turn directions from the user's current
 * location to this place. Works with just a name too (destination= accepts
 * a search string, not only coordinates), per the spec.
 */
export function googleMapsDirectionsUrl(place: PlaceLike): string {
  const destination = place.lat != null && place.lng != null ? `${place.lat},${place.lng}` : place.name
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`
}

export interface PlaceChipProps {
  place: PlaceLike
  /** Compact: icon-only actions (for tight rows). Default shows text labels. */
  compact?: boolean
  className?: string
}

/**
 * Compact chip showing a place's name with two deep-link actions: open the
 * Google Maps place page, and get Directions from the user's current
 * location. Both links work even when we only have a name (no lat/lng) by
 * falling back to Google's search/destination query syntax.
 */
export function PlaceChip({ place, compact = false, className = '' }: PlaceChipProps) {
  const hasCoords = place.lat != null && place.lng != null

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--border-default)] bg-[var(--surface-raised)] py-1 pl-2.5 pr-1.5 text-sm ${className}`}
    >
      <span className="shrink-0" aria-hidden="true">
        📍
      </span>
      <span className="truncate max-w-[12rem] font-medium text-[var(--text-primary)]" title={place.name}>
        {place.name}
      </span>
      {!hasCoords && (
        <span className="shrink-0 text-xs text-[var(--text-muted)]" title="No coordinates yet">
          (unpinned)
        </span>
      )}
      <span className="flex items-center gap-0.5 shrink-0">
        <a
          href={googleMapsPlaceUrl(place)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium text-accent-700 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-950"
          title="Open in Google Maps"
        >
          🗺️{!compact && <span>Maps</span>}
        </a>
        <a
          href={googleMapsDirectionsUrl(place)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium text-accent-700 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-950"
          title="Get directions"
        >
          🧭{!compact && <span>Directions</span>}
        </a>
      </span>
    </span>
  )
}
