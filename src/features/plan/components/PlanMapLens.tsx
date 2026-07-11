import { useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression, LatLngTuple } from 'leaflet'
import { Button, EmptyState, Skeleton } from '../../../components/ui'
import { ErrorState } from '../../../components/ui/illustrations'
import { usePlaces, type Place } from '../../../lib/queries/usePlaces'
import { ensureLeafletDefaultIcon, emojiDivIcon, PlacePicker } from '../../places'
import { colorForDayIndex } from '../../places/lib/mapMarkers'
import { placesWithoutCoordinates } from '../../places/lib/unpinnedPlaces'
import { CATEGORY_CONFIG } from '../../timeline/lib/categoryConfig'
import type { PlanItem } from '../lib/planItems'
import type { Trip } from '../../../types'

ensureLeafletDefaultIcon()

/** Local date-only day-index diff (day index within the trip), ignoring time-of-day/TZ noise — this lens's own copy since it's a one-liner, not worth a shared export. */
function dayIndexFor(dateStr: string, tripStartDateStr: string): number {
  const date = new Date(`${dateStr}T00:00:00`)
  const start = new Date(`${tripStartDateStr}T00:00:00`)
  const diffMs = date.getTime() - start.getTime()
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)))
}

function FitBounds({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap()
  useMemo(() => {
    if (bounds) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 })
  }, [bounds, map])
  return null
}

interface UnpinnedPlacesSectionProps {
  places: Place[]
  onFix: (place: Place) => void
}

/**
 * Compact, collapsed-by-default disclosure for places that exist on the
 * trip but have no coordinates (see unpinnedPlaces.ts) — the only surface
 * left after TripMapTab's removal that surfaces this gap and offers a fix
 * path. Sits below the map (or below the "no pins yet" empty state) rather
 * than blocking either, since it's a secondary, non-blocking affordance.
 */
function UnpinnedPlacesSection({ places, onFix }: UnpinnedPlacesSectionProps) {
  const [expanded, setExpanded] = useState(false)
  if (places.length === 0) return null

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-sunken)] transition-colors"
        aria-expanded={expanded}
      >
        <span>
          📍 {places.length} {places.length === 1 ? 'place' : 'places'} {places.length === 1 ? "isn't" : "aren't"} on
          the map yet
        </span>
        <span aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">
          {expanded ? '▲' : '▼'}
        </span>
      </button>
      {expanded && (
        <ul className="space-y-1.5 border-t border-[var(--border-subtle)] p-3">
          {places.map((place) => (
            <li key={place.id}>
              <button
                type="button"
                onClick={() => onFix(place)}
                className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-page)] px-3 py-2 text-left text-sm hover:border-accent-400 transition-colors"
              >
                <span className="truncate">{place.name}</span>
                <span className="shrink-0 text-xs font-medium text-accent-700 dark:text-accent-400">
                  Fix location
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export interface PlanMapLensProps {
  trip: Trip
  items: PlanItem[]
  onOpenItem: (item: PlanItem) => void
}

/**
 * Map lens (plan §2): the same PlanItem[] as day-colored pins — decided
 * and booked items render solid, proposals render hollow/pulsing to read
 * as "not settled yet". Tapping a pin opens the same PlanItemSheet used
 * everywhere else, via `onOpenItem`.
 */
export function PlanMapLens({ trip, items, onOpenItem }: PlanMapLensProps) {
  const placesQuery = usePlaces(trip.id)
  const { data: places, isLoading: placesLoading, isError: placesError } = placesQuery
  const placesById = useMemo(() => new Map((places || []).map((p) => [p.id, p])), [places])

  const pins = useMemo(() => {
    return items
      .filter((item) => item.placeId)
      .map((item) => ({ item, place: placesById.get(item.placeId!) }))
      .filter((x): x is { item: PlanItem; place: NonNullable<typeof x.place> } => !!x.place && x.place.lat != null && x.place.lng != null)
      .map(({ item, place }) => {
        const dayIndex = item.date ? dayIndexFor(item.date, trip.start_date) : 0
        const color = colorForDayIndex(dayIndex)
        const emoji = item.category ? CATEGORY_CONFIG[item.category as keyof typeof CATEGORY_CONFIG]?.emoji ?? '📍' : '📍'
        const isSolid = item.stage === 'decided' || item.stage === 'booked'
        return { item, place, color, emoji, isSolid }
      })
  }, [items, placesById, trip.start_date])

  const points: LatLngTuple[] = pins.map((p) => [p.place.lat!, p.place.lng!])
  const bounds: LatLngBoundsExpression | null = points.length > 0 ? points : null

  // Places on this trip with no lat/lng (name-only PlacePicker entries, or
  // an unresolved link paste) — they can never render as pins. Any
  // participant can fix one via the same PlacePicker used to create it
  // (existingPlace mode); there's no existing permission pattern
  // restricting place edits elsewhere (AddToPlanSheet/EventEditorSheet/
  // BookingEditorSheet all let any participant create/attach places), so
  // this stays consistent rather than inventing a new gate.
  const unpinnedPlaces = useMemo(() => placesWithoutCoordinates(places), [places])
  const [fixPlace, setFixPlace] = useState<Place | null>(null)

  // Loading gate (UPGRADE_MASTER_PLAN.md audit item 3): without this, "no
  // pinned places yet" briefly flashed while places was still in flight.
  if (placesLoading) {
    return <Skeleton variant="card" height={420} />
  }

  if (placesError) {
    return (
      <EmptyState
        icon={<ErrorState className="w-24 h-24 text-danger-500" />}
        title="Couldn't load the map"
        description="Something went wrong loading this trip's places. Check your connection and try again."
        action={
          <Button variant="primary" onClick={() => placesQuery.refetch()}>
            Retry
          </Button>
        }
      />
    )
  }

  if (pins.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon="🗺️"
          title="No pinned places yet"
          description="Attach a place to a plan item and it'll show up here as a pin."
        />
        <UnpinnedPlacesSection places={unpinnedPlaces} onFix={setFixPlace} />
        {fixPlace && (
          <PlacePicker
            isOpen={!!fixPlace}
            onClose={() => setFixPlace(null)}
            tripId={trip.id}
            title={`Pin "${fixPlace.name}"`}
            existingPlace={fixPlace}
            onPicked={() => setFixPlace(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]" style={{ height: 'min(70vh, 560px)' }}>
        <MapContainer center={points[0]} zoom={13} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds bounds={bounds} />
          {pins.map(({ item, place, color, emoji, isSolid }) => (
            <Marker
              key={item.id}
              position={[place.lat!, place.lng!]}
              icon={emojiDivIcon(emoji, color, { size: isSolid ? 30 : 24, ring: isSolid })}
              eventHandlers={{ click: () => onOpenItem(item) }}
            >
              <Popup>
                <span className={isSolid ? '' : 'italic'}>
                  {item.title}
                  {!isSolid && ' (proposed)'}
                </span>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
      <UnpinnedPlacesSection places={unpinnedPlaces} onFix={setFixPlace} />
      {fixPlace && (
        <PlacePicker
          isOpen={!!fixPlace}
          onClose={() => setFixPlace(null)}
          tripId={trip.id}
          title={`Pin "${fixPlace.name}"`}
          existingPlace={fixPlace}
          onPicked={() => setFixPlace(null)}
        />
      )}
    </div>
  )
}
