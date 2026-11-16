import { describe, expect, it } from 'vitest'
import { externalHostLabel, safeExternalUrl } from './externalLink'

describe('externalLink', () => {
  it('only http(s) is ever linked', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,x')).toBeNull()
    expect(safeExternalUrl('https://www.booking.com/h')).toBe('https://www.booking.com/h')
    expect(externalHostLabel('https://www.booking.com/h')).toBe('booking.com')
  })
})
