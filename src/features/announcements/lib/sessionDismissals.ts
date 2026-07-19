/**
 * Session-scoped dismissal memory. The DB row in announcement_dismissals is
 * what makes "seen once" hold across devices — this sessionStorage mirror
 * only guarantees that an announcement whose dismissal INSERT failed stays
 * hidden for the rest of the session (and across query refetches) instead
 * of popping back up. Storage failures degrade to "no memory", never throw.
 */

const KEY = 'trips.announcements.session-dismissed'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function getSessionDismissedIds(): string[] {
  const s = storage()
  if (!s) return []
  try {
    const parsed: unknown = JSON.parse(s.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export function addSessionDismissedId(id: string): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(KEY, JSON.stringify([...new Set([...getSessionDismissedIds(), id])]))
  } catch {
    // Quota/private-mode failure: the react-query cache still hides it until reload.
  }
}
