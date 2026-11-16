import { externalHostLabel } from '../../../lib/externalLink'

export { safeExternalUrl, externalHostLabel } from '../../../lib/externalLink'

/** "Organizer's link: booking.com ↗", or null when the URL is unusable. */
export function organizerLinkLabel(raw: string | null | undefined): string | null {
  const host = externalHostLabel(raw)
  return host ? `Organizer's link: ${host} ↗` : null
}
