import { describe, it, expect } from 'vitest'
import { safeExternalUrl, externalHostLabel, organizerLinkLabel } from './organizerLink'

describe('organizerLink', () => {
  it('accepts http(s) and derives host', () => {
    expect(externalHostLabel('https://www.booking.com/hotel/x?a=1')).toBe('booking.com')
    expect(organizerLinkLabel(' http://example.org/p ')).toBe("Organizer's link: example.org ↗")
  })
  it('rejects non-http schemes and junk', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('mailto:a@b.c')).toBeNull()
    expect(safeExternalUrl('booking.com')).toBeNull()
    expect(safeExternalUrl('')).toBeNull()
    expect(organizerLinkLabel(null)).toBeNull()
  })
})
