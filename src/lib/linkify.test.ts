import { describe, it, expect } from 'vitest'
import { internalLinkLabel, linkifySegments, shortenUrl } from './linkify'

describe('linkifySegments', () => {
  it('passes through text with no URLs unchanged', () => {
    expect(linkifySegments('Bring €250-300 in cash, drawn before you board.')).toEqual([
      { type: 'text', value: 'Bring €250-300 in cash, drawn before you board.' },
    ])
  })

  it('returns an empty array for empty text', () => {
    expect(linkifySegments('')).toEqual([])
  })

  it('detects a single URL surrounded by text', () => {
    const segments = linkifySegments('Provisioning pre-order at https://store.sunsail.com/uk deadline 7 days ahead.')
    expect(segments).toEqual([
      { type: 'text', value: 'Provisioning pre-order at ' },
      { type: 'external-link', href: 'https://store.sunsail.com/uk', label: 'store.sunsail.com/…' },
      { type: 'text', value: ' deadline 7 days ahead.' },
    ])
  })

  it('detects multiple URLs in one note', () => {
    const segments = linkifySegments('See https://a.example.com/one and also https://b.example.com/two for details.')
    const links = segments.filter((s) => s.type !== 'text')
    expect(links).toEqual([
      { type: 'external-link', href: 'https://a.example.com/one', label: 'a.example.com/…' },
      { type: 'external-link', href: 'https://b.example.com/two', label: 'b.example.com/…' },
    ])
  })

  it('handles a URL that is the entire note (no surrounding text)', () => {
    const segments = linkifySegments('https://hub.sunsail.com/e3t/verylongtrackingtoken')
    expect(segments).toEqual([
      { type: 'external-link', href: 'https://hub.sunsail.com/e3t/verylongtrackingtoken', label: 'hub.sunsail.com/…' },
    ])
  })

  it('preserves multi-line notes around the link (matches the Sunsail note shape)', () => {
    const text = 'https://hub.sunsail.com/e3t/abc\n\nLog in with your email — you will receive a code.'
    const segments = linkifySegments(text)
    expect(segments[0]).toEqual({ type: 'external-link', href: 'https://hub.sunsail.com/e3t/abc', label: 'hub.sunsail.com/…' })
    expect(segments[1]).toEqual({ type: 'text', value: '\n\nLog in with your email — you will receive a code.' })
  })

  it('trims trailing sentence punctuation off a detected URL', () => {
    const segments = linkifySegments('Details at https://example.com/path.')
    expect(segments[1]).toEqual({ type: 'external-link', href: 'https://example.com/path', label: 'example.com/…' })
  })

  it('trims a trailing closing parenthesis when the URL is not itself parenthesized', () => {
    const segments = linkifySegments('(see https://example.com/info)')
    expect(segments[1]).toEqual({ type: 'external-link', href: 'https://example.com/info', label: 'example.com/…' })
  })

  it('renders app-origin URLs as internal links with a friendly label', () => {
    const segments = linkifySegments(
      'Open People → "Your travel details" → Add. https://trips.fontem.ai/46efa496-11b6-49c8-b229-c72161f59126?tab=people&open=travel-details'
    )
    expect(segments[1]).toEqual({
      type: 'internal-link',
      href: '/46efa496-11b6-49c8-b229-c72161f59126?tab=people&open=travel-details',
      label: 'Your travel details',
    })
  })

  it('renders app-origin URLs with www. stripped for internal-link matching too', () => {
    const segments = linkifySegments('https://www.trips.fontem.ai/abc123?tab=decisions')
    expect(segments[0]).toEqual({ type: 'internal-link', href: '/abc123?tab=decisions', label: 'Decisions' })
  })

  it('falls back to the raw path for an internal link with no recognized ?tab=/?open=', () => {
    const segments = linkifySegments('https://trips.fontem.ai/abc123?foo=bar')
    expect(segments[0]).toEqual({ type: 'internal-link', href: '/abc123?foo=bar', label: '/abc123' })
  })
})

describe('shortenUrl', () => {
  it('strips a leading www.', () => {
    expect(shortenUrl('https://www.example.com')).toBe('example.com')
  })

  it('is the bare hostname when the URL has no path beyond "/"', () => {
    expect(shortenUrl('https://example.com')).toBe('example.com')
    expect(shortenUrl('https://example.com/')).toBe('example.com')
  })

  it('appends an ellipsis marker when there is a path', () => {
    expect(shortenUrl('https://hub.sunsail.com/e3t/Ctc/DN')).toBe('hub.sunsail.com/…')
  })

  it('appends an ellipsis marker for query-only URLs (no path)', () => {
    expect(shortenUrl('https://example.com?ref=123')).toBe('example.com/…')
  })

  it('falls back to the raw input for an unparseable URL', () => {
    expect(shortenUrl('not a url')).toBe('not a url')
  })
})

describe('internalLinkLabel', () => {
  it('maps each known deep-link target to its friendly label', () => {
    const cases: Array<[string, string]> = [
      ['https://trips.fontem.ai/abc?tab=decisions', 'Decisions'],
      ['https://trips.fontem.ai/abc?tab=people', 'People'],
      ['https://trips.fontem.ai/abc?tab=money', 'Money'],
      ['https://trips.fontem.ai/abc?tab=plan', 'Plan'],
      ['https://trips.fontem.ai/abc?tab=today', 'Today'],
      ['https://trips.fontem.ai/abc?open=travel-details', 'Your travel details'],
      ['https://trips.fontem.ai/abc?open=actions-bring', 'Bring list'],
      ['https://trips.fontem.ai/abc?open=actions', 'Actions'],
      ['https://trips.fontem.ai/abc?tab=people&open=travel-details', 'Your travel details'],
    ]
    for (const [url, label] of cases) {
      expect(internalLinkLabel(new URL(url))).toBe(label)
    }
  })

  it('falls back to the pathname when nothing matches', () => {
    expect(internalLinkLabel(new URL('https://trips.fontem.ai/abc?foo=bar'))).toBe('/abc')
  })
})
