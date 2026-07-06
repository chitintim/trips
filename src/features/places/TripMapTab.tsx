import { useMemo, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap } from 'react-leaflet'
import type { LatLngBoundsExpression, LatLngTuple } from 'leaflet'
import { Chip, EmptyState, Spinner } from '../../components/ui'
import { usePlaces, useOptions, useTimeline, useExpenses } from '../../lib/queries'
import type { Tables } from '../../types/database.types'
import { ensureLeafletDefaultIcon, emojiDivIcon } from './lib/leafletSetup'
import {
  colorForDayIndex,
  timelineCategoryEmoji,
  OPTION_MARKER_COLOR,
  OPTION_MARKER_EMOJI,
  EXPENSE_MARKER_COLOR,
  EXPENSE_MARKER_EMOJI,
} from './lib/mapMarkers'
import { PlaceChip } from './components/PlaceChip'
import { PlacePicker } from './components/PlacePicker'
import { formatPlaceMoney } from './lib/formatPlaceMoney'

ensureLeafletDefaultIcon()

type Layer = 'itinerary' | 'options' | 'spending'

interface SelectedEntity {
  kind: 'timeline' | 'option' | 'expense'
  title: string
  subtitle?: string
  place: Tables<'places'>
}

/** Local date-only diff (day index within the trip), ignoring time-of-day/TZ noise. */
function dayIndexFor(dateStr: string, tripStartDateStr: string): number {
  const date = new Date(`${dateStr}T00:00:00`)
  const start = new Date(`${tripStartDateStr}T00:00:00`)
  const diffMs = date.getTime() - start.getTime()
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)))
}

function FitBounds({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap()
  useMemo(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 })
    }
  }, [bounds, map])
  return null
}

export interface TripMapTabProps {
  tripId: string
  /** Trip start date (YYYY-MM-DD), used to color itinerary markers by day. */
  tripStartDate?: string
}

/**
 * The trip map view: Leaflet + OSM tiles with three toggleable layers
 * (Itinerary / Options / Spending), a day-color legend, a bottom card for
 * the selected marker with deep links out, and a list of name-only places
 * (no coordinates yet) that can be geocode-fixed via PlacePicker.
 */
export function TripMapTab({ tripId, tripStartDate }: TripMapTabProps) {
  const { data: places = [], isLoading: placesLoading } = usePlaces(tripId)
  const { data: timelineEvents = [], isLoading: timelineLoading } = useTimeline(tripId)
  const { data: options = [], isLoading: optionsLoading } = useOptions(tripId)
  const { data: expensesData, isLoading: expensesLoading } = useExpenses(tripId)
  const expenses = useMemo(() => expensesData?.expenses ?? [], [expensesData])

  const [activeLayers, setActiveLayers] = useState<Set<Layer>>(new Set(['itinerary', 'options', 'spending']))
  const [selected, setSelected] = useState<SelectedEntity | null>(null)
  const [fixPlace, setFixPlace] = useState<Tables<'places'> | null>(null)

  const isLoading = placesLoading || timelineLoading || optionsLoading || expensesLoading

  const placesById = useMemo(() => {
    const map = new Map<string, Tables<'places'>>()
    for (const p of places) map.set(p.id, p)
    return map
  }, [places])

  function toggleLayer(layer: Layer) {
    setActiveLayers((prev) => {
      const next = new Set(prev)
      if (next.has(layer)) next.delete(layer)
      else next.add(layer)
      return next
    })
  }

  // ---- Itinerary: events with a place_id + coordinates, grouped by day ----
  const itineraryByDay = useMemo(() => {
    const withPlace = timelineEvents
      .filter((e) => e.place_id)
      .map((e) => ({ event: e, place: e.place_id ? placesById.get(e.place_id) : undefined }))
      .filter((x): x is { event: (typeof timelineEvents)[number]; place: Tables<'places'> } =>
        !!x.place && x.place.lat != null && x.place.lng != null
      )

    const byDate = new Map<string, typeof withPlace>()
    for (const item of withPlace) {
      const list = byDate.get(item.event.event_date) ?? []
      list.push(item)
      byDate.set(item.event.event_date, list)
    }
    // Sort dates chronologically. Day index is anchored to the trip's
    // start date when known (so "Day 3" always means the same calendar day
    // across tabs), falling back to a 0-based index over just the dates
    // that actually have pinned events.
    const sortedDates = [...byDate.keys()].sort()
    return sortedDates.map((date, i) => {
      const dayIndex = tripStartDate ? dayIndexFor(date, tripStartDate) : i
      return {
        date,
        dayIndex,
        color: colorForDayIndex(dayIndex),
        items: byDate.get(date)!,
      }
    })
  }, [timelineEvents, placesById, tripStartDate])

  // ---- Options: options with a place_id + coordinates ----
  const optionMarkers = useMemo(
    () =>
      options
        .filter((o) => o.place_id)
        .map((o) => ({ option: o, place: o.place_id ? placesById.get(o.place_id) : undefined }))
        .filter((x): x is { option: (typeof options)[number]; place: Tables<'places'> } =>
          !!x.place && x.place.lat != null && x.place.lng != null
        ),
    [options, placesById]
  )

  // ---- Expenses: expenses with a place_id + coordinates ----
  const expenseMarkers = useMemo(
    () =>
      expenses
        .filter((e) => e.place_id)
        .map((e) => ({ expense: e, place: e.place_id ? placesById.get(e.place_id) : undefined }))
        .filter((x): x is { expense: (typeof expenses)[number]; place: Tables<'places'> } =>
          !!x.place && x.place.lat != null && x.place.lng != null
        ),
    [expenses, placesById]
  )

  // ---- Places with no coordinates yet (name-only) ----
  const unpinnedPlaces = useMemo(() => places.filter((p) => p.lat == null || p.lng == null), [places])

  const allPoints: LatLngTuple[] = useMemo(() => {
    const pts: LatLngTuple[] = []
    if (activeLayers.has('itinerary')) {
      for (const day of itineraryByDay) for (const item of day.items) pts.push([item.place.lat!, item.place.lng!])
    }
    if (activeLayers.has('options')) {
      for (const m of optionMarkers) pts.push([m.place.lat!, m.place.lng!])
    }
    if (activeLayers.has('spending')) {
      for (const m of expenseMarkers) pts.push([m.place.lat!, m.place.lng!])
    }
    return pts
  }, [activeLayers, itineraryByDay, optionMarkers, expenseMarkers])

  const bounds: LatLngBoundsExpression | null = allPoints.length > 0 ? allPoints : null
  const hasAnyPinnedPlaces = allPoints.length > 0

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size="lg" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Layer toggles */}
      <div className="flex flex-wrap gap-2">
        <Chip selected={activeLayers.has('itinerary')} onClick={() => toggleLayer('itinerary')} icon="🗓️">
          Itinerary
        </Chip>
        <Chip selected={activeLayers.has('options')} onClick={() => toggleLayer('options')} icon={OPTION_MARKER_EMOJI}>
          Options
        </Chip>
        <Chip selected={activeLayers.has('spending')} onClick={() => toggleLayer('spending')} icon={EXPENSE_MARKER_EMOJI}>
          Spending
        </Chip>
      </div>

      {!hasAnyPinnedPlaces ? (
        <EmptyState
          icon="🗺️"
          title="No places on the map yet"
          description="Add places to your itinerary, options, or expenses (paste a Google Maps link or search by name) and they'll show up here."
        />
      ) : (
        <>
          {/* Map — full-height-ish mobile-first container, minus safe areas
              handled by the parent tab layout. */}
          <div
            className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]"
            style={{ height: 'min(70vh, 560px)' }}
          >
            <MapContainer
              center={allPoints[0]}
              zoom={13}
              style={{ height: '100%', width: '100%' }}
              scrollWheelZoom
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <FitBounds bounds={bounds} />

              {activeLayers.has('itinerary') &&
                itineraryByDay.map((day) => (
                  <div key={day.date}>
                    <Polyline
                      positions={day.items.map((item) => [item.place.lat!, item.place.lng!] as LatLngTuple)}
                      pathOptions={{ color: day.color, weight: 3, opacity: 0.7 }}
                    />
                    {day.items.map((item, seq) => (
                      <Marker
                        key={item.event.id}
                        position={[item.place.lat!, item.place.lng!]}
                        icon={emojiDivIcon(String(seq + 1), day.color, { size: 30, ring: true })}
                        eventHandlers={{
                          click: () =>
                            setSelected({
                              kind: 'timeline',
                              title: item.event.title,
                              subtitle: `Day ${day.dayIndex + 1} · Stop ${seq + 1} · ${timelineCategoryEmoji(item.event.category)} ${item.event.category}`,
                              place: item.place,
                            }),
                        }}
                      >
                        <Popup>{item.event.title}</Popup>
                      </Marker>
                    ))}
                  </div>
                ))}

              {activeLayers.has('options') &&
                optionMarkers.map(({ option, place }) => (
                  <Marker
                    key={option.id}
                    position={[place.lat!, place.lng!]}
                    icon={emojiDivIcon(OPTION_MARKER_EMOJI, OPTION_MARKER_COLOR, { size: 30 })}
                    eventHandlers={{
                      click: () =>
                        setSelected({
                          kind: 'option',
                          title: option.title,
                          subtitle: option.price != null ? `${option.currency ?? ''} ${option.price}`.trim() : undefined,
                          place,
                        }),
                    }}
                  >
                    <Popup>{option.title}</Popup>
                  </Marker>
                ))}

              {activeLayers.has('spending') &&
                expenseMarkers.map(({ expense, place }) => (
                  <Marker
                    key={expense.id}
                    position={[place.lat!, place.lng!]}
                    icon={emojiDivIcon(EXPENSE_MARKER_EMOJI, EXPENSE_MARKER_COLOR, { size: 26 })}
                    eventHandlers={{
                      click: () =>
                        setSelected({
                          kind: 'expense',
                          title: expense.description,
                          subtitle: formatPlaceMoney(expense.amount, expense.currency),
                          place,
                        }),
                    }}
                  >
                    <Popup>{expense.description}</Popup>
                  </Marker>
                ))}
            </MapContainer>
          </div>

          {/* Day-color legend */}
          {activeLayers.has('itinerary') && itineraryByDay.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-xs text-[var(--text-secondary)]">
              {itineraryByDay.map((day) => (
                <span key={day.date} className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: day.color }}
                    aria-hidden="true"
                  />
                  Day {day.dayIndex + 1} ({new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})
                </span>
              ))}
            </div>
          )}

          {/* Selected marker bottom card */}
          {selected && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--text-primary)] truncate">{selected.title}</div>
                  {selected.subtitle && (
                    <div className="text-sm text-[var(--text-secondary)]">{selected.subtitle}</div>
                  )}
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2">
                <PlaceChip place={selected.place} />
              </div>
            </div>
          )}
        </>
      )}

      {/* Places with no coordinates yet — geocode-fixable via PlacePicker */}
      {unpinnedPlaces.length > 0 && (
        <div className="mt-2">
          <h3 className="mb-2 text-sm font-semibold text-[var(--text-secondary)]">
            Places with no coordinates ({unpinnedPlaces.length})
          </h3>
          <ul className="space-y-1.5">
            {unpinnedPlaces.map((place) => (
              <li key={place.id}>
                <button
                  type="button"
                  onClick={() => setFixPlace(place)}
                  className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-left text-sm hover:border-accent-400 transition-colors"
                >
                  <span className="truncate">
                    📍 {place.name}
                  </span>
                  <span className="shrink-0 text-xs font-medium text-accent-700 dark:text-accent-400">Fix location</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {fixPlace && (
        <PlacePicker
          isOpen={!!fixPlace}
          onClose={() => setFixPlace(null)}
          tripId={tripId}
          title={`Pin "${fixPlace.name}"`}
          existingPlace={fixPlace}
          onPicked={() => setFixPlace(null)}
        />
      )}
    </div>
  )
}

// Exposed for callers that already know the trip's start date and want
// day-indexed coloring elsewhere (kept here rather than re-exported from
// mapMarkers to keep the trip-date math colocated with its only caller).
export { dayIndexFor }
