import { describe, it, expect } from 'vitest'
import { placesWithoutCoordinates } from './unpinnedPlaces'
import type { Place } from '../../../lib/queries/usePlaces'

function place(overrides: Partial<Place> & { id: string }): Place {
  return {
    trip_id: 'trip-1',
    name: 'Some place',
    address: null,
    lat: 35.6762,
    lng: 139.6503,
    google_maps_link: null,
    google_place_url: null,
    source: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('placesWithoutCoordinates', () => {
  it('returns an empty array when input is undefined', () => {
    expect(placesWithoutCoordinates(undefined)).toEqual([])
  })

  it('returns an empty array when every place has coordinates', () => {
    const places = [place({ id: 'a' }), place({ id: 'b' })]
    expect(placesWithoutCoordinates(places)).toEqual([])
  })

  it('includes places with a null lat', () => {
    const missingLat = place({ id: 'a', lat: null })
    expect(placesWithoutCoordinates([missingLat, place({ id: 'b' })])).toEqual([missingLat])
  })

  it('includes places with a null lng', () => {
    const missingLng = place({ id: 'a', lng: null })
    expect(placesWithoutCoordinates([missingLng, place({ id: 'b' })])).toEqual([missingLng])
  })

  it('includes places missing both lat and lng (the common name-only case)', () => {
    const nameOnly = place({ id: 'a', lat: null, lng: null })
    expect(placesWithoutCoordinates([nameOnly])).toEqual([nameOnly])
  })

  it('preserves order and can return multiple unpinned places', () => {
    const a = place({ id: 'a', lat: null, lng: null })
    const b = place({ id: 'b' })
    const c = place({ id: 'c', lat: null, lng: null })
    expect(placesWithoutCoordinates([a, b, c])).toEqual([a, c])
  })
})
