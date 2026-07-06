/**
 * Central Leaflet bootstrap: bundles the CSS locally (no CDN — CSP/offline
 * per workstream spec) and works around Leaflet's well-known "broken
 * default icon" issue under bundlers (Vite/webpack rewrite the image URLs
 * baked into leaflet's CSS/JS, so the default L.Icon can't find its PNGs
 * unless we re-point it at bundled asset URLs).
 *
 * In practice this app uses divIcon circle markers everywhere (see
 * mapMarkers.ts / TripMapTab) so the default icon is rarely instantiated,
 * but any library-internal fallback (e.g. a Marker without an explicit
 * icon prop) will use this fixed default instead of rendering broken
 * image icons.
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

let patched = false

export function ensureLeafletDefaultIcon() {
  if (patched) return
  patched = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (L.Icon.Default.prototype as any)._getIconUrl
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: markerIcon2x,
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
  })
}

/**
 * Build a divIcon showing an emoji inside a colored circle — the preferred
 * marker style per spec (no extra image assets, tokenized colors, reads
 * well at small map sizes).
 */
export function emojiDivIcon(emoji: string, color: string, opts?: { size?: number; ring?: boolean }): L.DivIcon {
  const size = opts?.size ?? 32
  const ring = opts?.ring ? `box-shadow: 0 0 0 2px white, 0 1px 4px rgba(0,0,0,0.35);` : `box-shadow: 0 1px 4px rgba(0,0,0,0.35);`
  return L.divIcon({
    className: 'trips-emoji-marker',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};
      display:flex;align-items:center;justify-content:center;
      font-size:${Math.round(size * 0.55)}px;line-height:1;
      ${ring}
    ">${emoji}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}
