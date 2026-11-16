import { describe, expect, it } from 'vitest'
import { priceSpokenText, speakable } from './priceTagText'

describe('priceTagText', () => {
  it('speaks the approximation and separators', () => {
    expect(speakable('≈£222 each')).toBe('about £222 each')
    expect(speakable('£2,000 total · 9 going · est.')).toBe('£2,000 total, 9 going, estimate')
  })
  it('joins headline, basis and sensitivity', () => {
    expect(priceSpokenText({ headline: '≈£222 each', basisLine: '£2,000 total · 9 invited · est.', sensitivityLine: '£250 each if 8 · £222 if 9' })).toBe(
      'about £222 each. £2,000 total, 9 invited, estimate. £250 each if 8, £222 if 9'
    )
  })
  it('adds the certainty word when there is no basis line', () => {
    expect(priceSpokenText({ headline: '£12/day each', certainty: 'decided' })).toBe('£12/day each, decided price')
    expect(priceSpokenText({ headline: '£12/day each' })).toBe('£12/day each')
  })
})
