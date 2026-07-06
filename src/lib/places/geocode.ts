import { supabase } from '../supabase'
import type { Tables, TablesInsert } from '../../types/database.types'

/**
 * Nominatim (OpenStreetMap) geocoding — free, keyless, but usage-policy
 * restricted to 1 request/second and requires an identifying User-Agent /
 * Referer. We throttle a single shared queue for the whole app so bursts of
 * vendor-name lookups (e.g. batch receipt geocoding) never exceed the
 * policy limit no matter how many callers fire concurrently.
 */

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search'
const MIN_REQUEST_INTERVAL_MS = 1000
const APP_USER_AGENT = 'TripsPlanner/1.0 (https://github.com/trips-app; contact via app)'

export interface NominatimResult {
  display_name: string
  lat: string
  lon: string
  place_id: number
  osm_type?: string
  osm_id?: number
  address?: Record<string, string>
}

export interface GeocodeResult {
  name: string
  lat: number
  lng: number
  address: string | null
}

// Module-level throttle queue: serializes all Nominatim requests app-wide
// to respect the 1 req/s usage policy, regardless of how many independent
// callers (receipt geocoding, PlacePicker search, etc.) invoke this module
// concurrently.
let queueTail: Promise<void> = Promise.resolve()
let lastRequestAt = 0

function scheduleThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - now)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    lastRequestAt = Date.now()
  })
  // Keep the queue moving even if `fn` throws — don't let one failure wedge
  // every subsequent geocode call behind it forever.
  queueTail = run.then(
    () => undefined,
    () => undefined
  )
  return run.then(fn)
}

/**
 * Search Nominatim for a free-text query (vendor name, place name, address
 * fragment). Returns an empty array on any network/parse failure — callers
 * should treat "no results" and "lookup failed" the same way (graceful
 * fallback to manual/name-only entry), per the places workstream spec.
 */
export async function searchPlace(query: string, opts?: { limit?: number }): Promise<GeocodeResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  try {
    return await scheduleThrottled(async () => {
      const url = new URL(NOMINATIM_BASE_URL)
      url.searchParams.set('format', 'json')
      url.searchParams.set('q', trimmed)
      url.searchParams.set('limit', String(opts?.limit ?? 5))
      url.searchParams.set('addressdetails', '1')

      const response = await fetch(url.toString(), {
        headers: {
          // Nominatim's usage policy requires a valid identifying
          // User-Agent OR Referer. Browsers block setting `User-Agent`
          // directly from fetch(), so the Referer (automatically sent by
          // the browser) plus this custom header covers both server-side
          // and browser callers.
          'User-Agent': APP_USER_AGENT,
          Accept: 'application/json',
        },
      })

      if (!response.ok) return []

      const results = (await response.json()) as NominatimResult[]
      return results.map((r) => ({
        name: r.display_name.split(',')[0].trim() || r.display_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        address: r.display_name,
      }))
    })
  } catch {
    // Network failure, CORS issue, offline, rate-limited (429), etc. —
    // fail gracefully so the UI can fall back to manual name-only entry.
    return []
  }
}

/**
 * Geocode a single best-match location for a name (+ optional address hint
 * to disambiguate, e.g. from a receipt's printed address) and, on success,
 * insert it into `places` so the result is cached and reused by place_id
 * next time. Returns null (never throws) when geocoding finds nothing or
 * the place insert fails — callers should fall back to a name-only place
 * or let the user fix it up later via PlacePicker.
 */
export async function geocodeAndCreatePlace(
  tripId: string,
  name: string,
  address?: string | null,
  source: Tables<'places'>['source'] = 'receipt'
): Promise<Tables<'places'> | null> {
  if (!name.trim()) return null

  const query = address ? `${name}, ${address}` : name
  const results = await searchPlace(query, { limit: 1})
  const best = results[0]

  const insert: TablesInsert<'places'> = best
    ? {
        trip_id: tripId,
        name,
        lat: best.lat,
        lng: best.lng,
        address: address ?? best.address,
        source,
      }
    : {
        // Geocoding found nothing — still record the place (name-only) so
        // it shows up in the "places with no coordinates" list and can be
        // fixed up later via PlacePicker, rather than silently dropping it.
        trip_id: tripId,
        name,
        lat: null,
        lng: null,
        address: address ?? null,
        source,
      }

  const { data, error } = await supabase.from('places').insert(insert).select().single()
  if (error) return null
  return data
}
