/**
 * Public surface of the site-announcements feature — one-time, super-admin
 * controlled popups shown to every user across the whole app.
 */
export { AnnouncementGate } from './components/AnnouncementGate'
export { AdminAnnouncementsTab } from './components/AdminAnnouncementsTab'
export { useVisibleAnnouncements, useDismissAnnouncement, announcementKeys } from './lib/useAnnouncements'
export type { VisibleAnnouncementsData, AdminAnnouncement } from './lib/useAnnouncements'
export { selectVisibleAnnouncement, announcementState, isAnnouncementActive } from './lib/visibility'
export type { AnnouncementState, AnnouncementWindow } from './lib/visibility'
