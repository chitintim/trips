/**
 * Parse a pasted Google Maps share link into a best-effort {name, lat, lng}.
 *
 * Google Maps produces several URL shapes depending on how the link was
 * shared (desktop "share" dialog, mobile app share sheet, address-bar copy,
 * search-result permalink, short link). We don't have a public API to
 * resolve these server-side (we deliberately do NOT touch supabase/functions
 * here per workstream scope), so this is a pure client-side, regex/URL based
 * best-effort parser. When the link can't be resolved to coordinates
 * client-side (e.g. short links that redirect), we return
 * `{ needsResolution: true }` so the UI can prompt the user to paste the
 * expanded URL from the browser address bar instead.
 */

export interface ParsedGoogleMapsLink {
  /** True when we couldn't extract coordinates and the caller must ask the
   * user for an expanded URL (e.g. maps.app.goo.gl short links, which
   * require a server-side redirect follow we don't perform here). */
  needsResolution: boolean
  /** Best-effort place name, if one could be extracted from the URL. */
  name: string | null
  lat: number | null
  lng: number | null
  /** Human-readable explanation, useful for inline UI feedback either way. */
  reason: string
}

const SHORT_LINK_HOSTS = ['maps.app.goo.gl', 'goo.gl']

function clampLat(lat: number): boolean {
  return lat >= -90 && lat <= 90
}
function clampLng(lng: number): boolean {
  return lng >= -180 && lng <= 180
}

function decodeNameSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).replace(/\+/g, ' ').trim()
  } catch {
    return segment.replace(/\+/g, ' ').trim()
  }
}

/**
 * Try to pull a human name out of a `/maps/place/<name>/...` segment.
 * Google encodes the name with + for spaces and percent-escapes.
 */
function extractPlaceName(pathname: string): string | null {
  const match = pathname.match(/\/maps\/place\/([^/]+)/)
  if (!match) return null
  const decoded = decodeNameSegment(match[1])
  // Google sometimes puts raw "lat,lng" as the "name" segment (when the
  // share was for a bare coordinate pin, not a named place) — not a name.
  if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(decoded)) return null
  return decoded || null
}

/**
 * Try `@lat,lng,zoom` viewport marker in the path, e.g.
 * `/maps/place/Some+Place/@35.6586,139.7454,17z/...`
 * or a bare map view `/maps/@35.6586,139.7454,15z`.
 */
function extractAtLatLng(pathname: string): { lat: number; lng: number } | null {
  const match = pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|$|\/)/)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lng = parseFloat(match[2])
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null
  if (!clampLat(lat) || !clampLng(lng)) return null
  return { lat, lng }
}

/**
 * Try Google's internal `!3dLAT!4dLNG` data-blob markers, present in the
 * long `data=!4m...` parameter on place-page URLs. This is usually the most
 * *precise* coordinate for the actual pin (the `@lat,lng` is just the
 * viewport center, which can be meaningfully different for large places).
 * We take the LAST !3d/!4d pair in the string, since Google Maps repeats
 * viewport info earlier in the blob and puts the actual place point later.
 */
function extractDataLatLng(url: string): { lat: number; lng: number } | null {
  const matches = [...url.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)]
  if (matches.length === 0) return null
  const last = matches[matches.length - 1]
  const lat = parseFloat(last[1])
  const lng = parseFloat(last[2])
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null
  if (!clampLat(lat) || !clampLng(lng)) return null
  return { lat, lng }
}

/**
 * Try `q=lat,lng` or `q=name` query param (old-style maps links,
 * `maps.google.com/maps?q=...`, and universal `?q=` deep links).
 */
function extractQueryParam(searchParams: URLSearchParams): { lat: number; lng: number } | { name: string } | null {
  const q = searchParams.get('q') ?? searchParams.get('query')
  if (!q) return null
  const coordMatch = q.match(/^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1])
    const lng = parseFloat(coordMatch[2])
    if (clampLat(lat) && clampLng(lng)) return { lat, lng }
    return null
  }
  return { name: q }
}

/**
 * Parse a pasted Google Maps URL (or a bare "lat,lng" string) into a place
 * draft. Never throws — always returns a result object describing what
 * (if anything) could be extracted.
 */
export function parseGoogleMapsLink(input: string): ParsedGoogleMapsLink {
  const raw = input.trim()
  if (!raw) {
    return { needsResolution: false, name: null, lat: null, lng: null, reason: 'Empty input' }
  }

  // Bare "lat,lng" pasted directly (not a URL at all) — support it since
  // it's a common copy-paste from Google Maps' app share sheet on some
  // platforms and from Apple/other map apps.
  const bareCoordMatch = raw.match(/^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/)
  if (bareCoordMatch) {
    const lat = parseFloat(bareCoordMatch[1])
    const lng = parseFloat(bareCoordMatch[2])
    if (clampLat(lat) && clampLng(lng)) {
      return { needsResolution: false, name: null, lat, lng, reason: 'Parsed bare coordinates' }
    }
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      needsResolution: false,
      name: null,
      lat: null,
      lng: null,
      reason: 'Not a recognizable URL or coordinate pair',
    }
  }

  const host = url.hostname.replace(/^www\./, '')
  const isGoogleMapsHost =
    host === 'maps.google.com' ||
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    SHORT_LINK_HOSTS.includes(host)

  if (!isGoogleMapsHost) {
    return {
      needsResolution: false,
      name: null,
      lat: null,
      lng: null,
      reason: 'Not a Google Maps URL',
    }
  }

  // Short links (maps.app.goo.gl, goo.gl/maps/...) redirect server-side —
  // we can't follow them from the browser due to CORS, and this workstream
  // doesn't touch the edge functions. Ask the user for the expanded URL.
  if (SHORT_LINK_HOSTS.includes(host)) {
    return {
      needsResolution: true,
      name: null,
      lat: null,
      lng: null,
      reason:
        'Short Google Maps links (maps.app.goo.gl) redirect on Google’s servers, so we can’t read the destination from here. Open the link, then paste the full URL from your browser’s address bar instead.',
    }
  }

  const name = extractPlaceName(url.pathname)

  // Prefer the precise !3d/!4d data blob coordinate, then the @lat,lng
  // viewport marker, then a q=lat,lng query param.
  const dataLatLng = extractDataLatLng(raw)
  if (dataLatLng) {
    return {
      needsResolution: false,
      name,
      lat: dataLatLng.lat,
      lng: dataLatLng.lng,
      reason: 'Parsed precise coordinates from place data',
    }
  }

  const atLatLng = extractAtLatLng(url.pathname)
  if (atLatLng) {
    return {
      needsResolution: false,
      name,
      lat: atLatLng.lat,
      lng: atLatLng.lng,
      reason: 'Parsed coordinates from map viewport',
    }
  }

  const queryResult = extractQueryParam(url.searchParams)
  if (queryResult && 'lat' in queryResult) {
    return {
      needsResolution: false,
      name,
      lat: queryResult.lat,
      lng: queryResult.lng,
      reason: 'Parsed coordinates from q= parameter',
    }
  }

  // No coordinates found anywhere, but we might still have a name (from the
  // /place/<name>/ segment or a q=name search param) — or a search query
  // that could be geocoded downstream via Nominatim.
  const queryName = queryResult && 'name' in queryResult ? queryResult.name : null
  const resolvedName = name ?? queryName

  if (resolvedName) {
    return {
      needsResolution: false,
      name: resolvedName,
      lat: null,
      lng: null,
      reason: 'Found a name but no coordinates in the URL — try searching by name to geocode it',
    }
  }

  return {
    needsResolution: false,
    name: null,
    lat: null,
    lng: null,
    reason: 'Recognized as a Google Maps URL, but couldn’t find a name or coordinates in it',
  }
}
