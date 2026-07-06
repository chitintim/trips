import { describe, it, expect } from 'vitest'
import { parseGoogleMapsLink } from './parseGoogleMapsLink'

describe('parseGoogleMapsLink', () => {
  it('parses @lat,lng in the path with a place name', () => {
    const url = 'https://www.google.com/maps/place/Tsukiji+Outer+Market/@35.6654,139.7707,17z/data=!3m1!4b1'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.name).toBe('Tsukiji Outer Market')
    expect(result.lat).toBeCloseTo(35.6654)
    expect(result.lng).toBeCloseTo(139.7707)
  })

  it('prefers the precise !3d/!4d data param coordinates over the @ viewport center', () => {
    const url =
      'https://www.google.com/maps/place/Shibuya+Crossing/@35.6595,139.7004,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d35.6598!4d139.7006'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.name).toBe('Shibuya Crossing')
    expect(result.lat).toBeCloseTo(35.6598)
    expect(result.lng).toBeCloseTo(139.7006)
  })

  it('parses !3d/!4d data params without a name segment', () => {
    const url = 'https://www.google.com/maps/@?api=1&data=!3m1!4b1!4m5!3m4!1s0x0!8m2!3d48.8584!4d2.2945'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeCloseTo(48.8584)
    expect(result.lng).toBeCloseTo(2.2945)
  })

  it('parses q=lat,lng query param (old-style maps link)', () => {
    const url = 'https://maps.google.com/maps?q=51.5007,-0.1246'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeCloseTo(51.5007)
    expect(result.lng).toBeCloseTo(-0.1246)
  })

  it('parses q=name as a name (no coordinates) for downstream geocoding', () => {
    const url = 'https://www.google.com/maps?q=Eiffel+Tower'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeNull()
    expect(result.lng).toBeNull()
    expect(result.name).toBe('Eiffel Tower')
  })

  it('parses a /maps/place/<name>/ segment with no coordinates at all', () => {
    const url = 'https://www.google.com/maps/place/Some+Restaurant'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeNull()
    expect(result.name).toBe('Some Restaurant')
  })

  it('does not mistake a bare lat,lng "name" segment (pin drop) for a real name', () => {
    const url = 'https://www.google.com/maps/place/35.6586,139.7454/@35.6586,139.7454,17z'
    const result = parseGoogleMapsLink(url)
    expect(result.name).toBeNull()
    expect(result.lat).toBeCloseTo(35.6586)
    expect(result.lng).toBeCloseTo(139.7454)
  })

  it('flags maps.app.goo.gl short links as needing resolution', () => {
    const result = parseGoogleMapsLink('https://maps.app.goo.gl/abCdEfGhIjK')
    expect(result.needsResolution).toBe(true)
    expect(result.lat).toBeNull()
    expect(result.name).toBeNull()
    expect(result.reason).toMatch(/address bar/i)
  })

  it('flags goo.gl/maps short links as needing resolution', () => {
    const result = parseGoogleMapsLink('https://goo.gl/maps/abCdEfGhIjK')
    expect(result.needsResolution).toBe(true)
  })

  it('parses a bare "lat,lng" string pasted directly (no URL)', () => {
    const result = parseGoogleMapsLink('35.6586, 139.7454')
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeCloseTo(35.6586)
    expect(result.lng).toBeCloseTo(139.7454)
    expect(result.name).toBeNull()
  })

  it('rejects out-of-range bare coordinates', () => {
    const result = parseGoogleMapsLink('200.0, 400.0')
    expect(result.lat).toBeNull()
    expect(result.lng).toBeNull()
  })

  it('returns a graceful non-resolution result for unrelated URLs', () => {
    const result = parseGoogleMapsLink('https://www.airbnb.com/rooms/12345')
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeNull()
    expect(result.name).toBeNull()
    expect(result.reason).toMatch(/not a google maps url/i)
  })

  it('returns a graceful result for empty input', () => {
    const result = parseGoogleMapsLink('   ')
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeNull()
  })

  it('returns a graceful result for garbage / unparseable input', () => {
    const result = parseGoogleMapsLink('not a url at all, just text')
    expect(result.needsResolution).toBe(false)
    expect(result.lat).toBeNull()
    expect(result.name).toBeNull()
  })

  it('handles a plain map-view @lat,lng URL with no /place/ segment', () => {
    const url = 'https://www.google.com/maps/@40.7484,-73.9857,15z'
    const result = parseGoogleMapsLink(url)
    expect(result.needsResolution).toBe(false)
    expect(result.name).toBeNull()
    expect(result.lat).toBeCloseTo(40.7484)
    expect(result.lng).toBeCloseTo(-73.9857)
  })

  it('decodes percent-encoded characters in place names', () => {
    const url = 'https://www.google.com/maps/place/Caf%C3%A9+de+Flore/@48.8540,2.3325,17z'
    const result = parseGoogleMapsLink(url)
    expect(result.name).toBe('Café de Flore')
  })
})
