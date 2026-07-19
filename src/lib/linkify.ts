/**
 * URL auto-detection for free-text note/title fields (action notes,
 * bring-list item titles). Splits text into plain-text segments and link
 * segments so callers can render clickable links without touching the
 * surrounding prose — extracted after the Sailing Sicily trip's Sunsail
 * actions turned out to carry a ~500-char hub.sunsail.com tracking URL in
 * their notes, rendered raw and unlinked.
 *
 * Two kinds of link:
 *  - external: opens in a new tab, display-shortened to a bare hostname
 *    (+ "/…" when there's more than just the origin) so a long tracking URL
 *    doesn't blow out a one-line note on mobile.
 *  - internal: a link back into this app (trips.fontem.ai, or whatever
 *    origin the app is currently served from — dev/preview included) —
 *    meant to be rendered as an in-app navigation instead of a new tab, with
 *    a friendly label derived from the ?tab=/?open= it points at (falling
 *    back to the raw path when nothing matches).
 */

export type LinkifySegment =
  | { type: 'text'; value: string }
  | { type: 'external-link'; href: string; label: string }
  | { type: 'internal-link'; href: string; label: string }

// http(s) only — deliberately doesn't try to linkify bare "example.com" or
// "www.example.com" text, since that's much likelier to false-positive on
// ordinary prose (e.g. "buy sunscreen") than a scheme-qualified URL.
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g

/** Hostnames (no "www.") this app is known to be served from. */
const APP_HOSTNAMES = ['trips.fontem.ai']

function isAppHostname(hostname: string): boolean {
  const bare = hostname.replace(/^www\./, '')
  if (APP_HOSTNAMES.includes(bare)) return true
  // Also treat "wherever this page is currently loaded from" as internal,
  // so dev/preview/staging origins deep-link in-app too without needing an
  // entry in APP_HOSTNAMES. No-ops outside a browser (e.g. these tests).
  return typeof window !== 'undefined' && window.location.hostname === hostname
}

/** hostname (no leading "www.") + "/…" when there's a path/query/hash beyond the bare origin. */
export function shortenUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const hasMore = (u.pathname && u.pathname !== '/') || u.search !== '' || u.hash !== ''
    return hasMore ? `${host}/…` : host
  } catch {
    return url
  }
}

/**
 * Friendly label for an in-app deep link, keyed off its ?tab=/?open=
 * params — small and easily extended as more seeded content links deeper
 * into the app. Falls back to the raw pathname when nothing matches.
 */
const INTERNAL_LINK_LABELS: Array<[test: (params: URLSearchParams) => boolean, label: string]> = [
  [(p) => p.get('open') === 'travel-details', 'Your travel details'],
  [(p) => p.get('open') === 'actions-bring', 'Bring list'],
  [(p) => p.get('open') === 'actions', 'Actions'],
  [(p) => p.get('tab') === 'decisions', 'Decisions'],
  [(p) => p.get('tab') === 'people', 'People'],
  [(p) => p.get('tab') === 'money', 'Money'],
  [(p) => p.get('tab') === 'plan', 'Plan'],
  [(p) => p.get('tab') === 'today', 'Today'],
]

export function internalLinkLabel(url: URL): string {
  for (const [test, label] of INTERNAL_LINK_LABELS) {
    if (test(url.searchParams)) return label
  }
  return url.pathname
}

/** Strips trailing punctuation that's almost always sentence structure, not part of the URL (e.g. "...guest-info.html." or "(see hub.sunsail.com)"). */
function trimTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?)\]]+$/, '')
}

/** Splits `text` into plain-text and link segments (see module doc for the internal/external distinction). Returns `[]` for empty input. */
export function linkifySegments(text: string): LinkifySegment[] {
  if (!text) return []
  const segments: LinkifySegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(URL_REGEX)) {
    const start = match.index ?? 0
    const href = trimTrailingPunctuation(match[0])
    if (!href) continue
    const end = start + href.length

    if (start > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, start) })

    let parsed: URL | null
    try {
      parsed = new URL(href)
    } catch {
      parsed = null
    }

    if (parsed && isAppHostname(parsed.hostname)) {
      segments.push({
        type: 'internal-link',
        href: `${parsed.pathname}${parsed.search}${parsed.hash}`,
        label: internalLinkLabel(parsed),
      })
    } else {
      segments.push({ type: 'external-link', href, label: shortenUrl(href) })
    }
    lastIndex = end
  }

  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) })
  return segments
}
