/**
 * Where a link in an assistant message may point. Only `https:` / `http:` addresses and in-app paths are kept: everything else
 * (javascript:, data:, vbscript:, file:, protocol-relative `//host`, relative junk) is dropped so the text shows without a link.
 */
export type SafeHref = { kind: 'external'; href: string } | { kind: 'internal'; href: string } | null

export function safeHref(raw: string | null | undefined): SafeHref {
  if (!raw) return null
  // Control characters / whitespace tricks ("java\tscript:") never belong in a real address.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw.trim())) return null
  const href = raw.trim()
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href)
      return url.protocol === 'https:' || url.protocol === 'http:' ? { kind: 'external', href: url.toString() } : null
    } catch {
      return null
    }
  }
  // In-app: an absolute app path (`/trips/<id>?open=...`) but never `//host` or a backslash form.
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')) return { kind: 'internal', href }
  return null
}

