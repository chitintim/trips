import { MapContainer, TileLayer, Marker } from 'react-leaflet'
import { ensureLeafletDefaultIcon, emojiDivIcon } from '../lib/leafletSetup'

ensureLeafletDefaultIcon()

export interface PlaceMapThumbProps {
  lat: number
  lng: number
  /** Emoji shown in the marker circle. Defaults to a pin. */
  emoji?: string
  color?: string
  className?: string
  height?: number
  zoom?: number
}

/**
 * Small, non-interactive "static-look" mini map for a single place — used
 * inline in cards/lists where a full interactive map would be noisy.
 * Dragging/scroll-zoom/double-click-zoom are all disabled so it reads as a
 * thumbnail, not an interactive widget.
 */
export function PlaceMapThumb({
  lat,
  lng,
  emoji = '📍',
  color = '#2563eb',
  className = '',
  height = 120,
  zoom = 15,
}: PlaceMapThumbProps) {
  return (
    <div
      className={`overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] ${className}`}
      style={{ height }}
      aria-hidden="true"
    >
      <MapContainer
        center={[lat, lng]}
        zoom={zoom}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        attributionControl={false}
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Marker position={[lat, lng]} icon={emojiDivIcon(emoji, color, { size: 28 })} />
      </MapContainer>
    </div>
  )
}
