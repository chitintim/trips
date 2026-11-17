import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMarkdown } from './markdown'
import { safeHref } from './safeHref'

const html = (md: string) => renderToStaticMarkup(createElement(ChatMarkdown, null, md))

describe('safeHref', () => {
  it('keeps https/http and app paths, drops everything else', () => {
    expect(safeHref('https://example.com/a')?.kind).toBe('external')
    expect(safeHref('http://example.com')?.kind).toBe('external')
    expect(safeHref('/trips/abc?open=todos')?.kind).toBe('internal')
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>', 'vbscript:x', 'file:///etc/passwd', '//evil.com', '/\\evil.com', 'mailto:a@b.c', '', null, undefined]) {
      expect(safeHref(bad as string | null)).toBeNull()
    }
  })
})

describe('ChatMarkdown', () => {
  it('renders bold, lists and safe links as elements, not literal markdown', () => {
    const out = html('**Food** is £33\n\n- pizza 21\n- lunch 12\n\n[menu](https://example.com/m)')
    expect(out).toContain('<strong')
    expect(out).toContain('<li')
    expect(out).toContain('href="https://example.com/m"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).not.toContain('**')
  })
  it('never outputs raw html, scripts or images', () => {
    const out = html('hi <script>alert(1)</script> <img src=x onerror=alert(1)> ![pic](https://example.com/p.png) <b onclick="x()">b</b>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('<b ')
  })
  it('neutralises javascript: and data: links (text stays, link goes)', () => {
    const out = html('[click](javascript:alert(1)) and [d](data:text/html;base64,AAAA) and [ok](https://example.com)')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text')
    expect(out).toContain('click')
    expect(out).toContain('href="https://example.com/"')
  })
  it('does not turn headings or tables into big elements', () => {
    const out = html('# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(out).not.toContain('<h1')
    expect(out).not.toContain('<table')
  })
})
