/**
 * The organizer's free-entered "link to more details" is an EXTERNAL page
 * (often a booking site), so it is labelled with its destination and never as
 * an in-app breakdown. Only http/https URLs are ever rendered.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

export function externalHostLabel(raw: string | null | undefined): string | null {
  const href = safeExternalUrl(raw)
  if (!href) return null
  return new URL(href).hostname.replace(/^www\./i, '') || null
}

/** "Organizer's link: booking.com ↗", or null when the URL is unusable. */
export function organizerLinkLabel(raw: string | null | undefined): string | null {
  const host = externalHostLabel(raw)
  return host ? `Organizer's link: ${host} ↗` : null
}
