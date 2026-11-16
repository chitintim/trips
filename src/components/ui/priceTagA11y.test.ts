import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PriceTag } from './PriceTag'

describe('PriceTag reads once to assistive tech', () => {
  const html = renderToStaticMarkup(createElement(PriceTag, { text: { headline: '≈£222 each', basisLine: '£471.47 total · split between 5 · paid' } }))

  it('only the spoken sentence is exposed; the visible spans sit inside an aria-hidden wrapper', () => {
    expect(html).toContain('<span class="sr-only">')
    expect(html).toContain('£471.47 total, split between 5, paid')
    const hiddenAt = html.indexOf('aria-hidden="true"')
    expect(hiddenAt).toBeGreaterThan(html.indexOf('sr-only'))
    const visible = html.slice(hiddenAt)
    expect(visible).toContain('£471.47 total · split between 5 · paid')
    expect(visible).toContain('≈£222 each')
    expect(html.slice(0, hiddenAt)).not.toContain('·')
  })
})
