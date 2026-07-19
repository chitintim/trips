/**
 * Pure visibility rules for site-wide announcements: which announcements
 * are inside their [starts_at, ends_at] window, and which single one (if
 * any) should pop up for a user given what they've already dismissed.
 * Kept free of Supabase/react-query so the selection logic is unit-testable.
 */

export interface AnnouncementWindow {
  id: string
  starts_at: string
  ends_at: string
}

export type AnnouncementState = 'scheduled' | 'active' | 'expired'

/** Lifecycle state relative to `now` (admin list badges + popup gating). */
export function announcementState(announcement: Pick<AnnouncementWindow, 'starts_at' | 'ends_at'>, now: Date = new Date()): AnnouncementState {
  const t = now.getTime()
  if (t < new Date(announcement.starts_at).getTime()) return 'scheduled'
  if (t > new Date(announcement.ends_at).getTime()) return 'expired'
  return 'active'
}

export function isAnnouncementActive(announcement: Pick<AnnouncementWindow, 'starts_at' | 'ends_at'>, now: Date = new Date()): boolean {
  return announcementState(announcement, now) === 'active'
}

/**
 * The single announcement to show on this app load: inside its active
 * window and not yet dismissed by this user. Oldest `starts_at` first, so
 * a backlog of announcements drains one per load in publication order —
 * the popup never stacks.
 */
export function selectVisibleAnnouncement<T extends AnnouncementWindow>(
  announcements: readonly T[],
  dismissedIds: ReadonlySet<string> | readonly string[],
  now: Date = new Date()
): T | null {
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds)
  const candidates = announcements
    .filter((a) => isAnnouncementActive(a, now) && !dismissed.has(a.id))
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  return candidates[0] ?? null
}
