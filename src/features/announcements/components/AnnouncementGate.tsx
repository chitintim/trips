import { useEffect, useState } from 'react'
import { Button, Markdown, Modal } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useDismissAnnouncement, useVisibleAnnouncements } from '../lib/useAnnouncements'
import { selectVisibleAnnouncement } from '../lib/visibility'

/** Seconds before the popup dismisses itself (the user has seen it — same DB dismissal as "Got it"). */
const AUTO_CLOSE_SECONDS = 10

/**
 * Site-wide one-time announcement popup, mounted once at the app shell
 * (App.tsx) so it appears on the dashboard and trip pages alike. Shows at
 * most ONE announcement per app load; closing it (button, backdrop, Escape,
 * or the 10s auto-close countdown) records a dismissal row so it never
 * renders again for this user on any device. Never blocks the app: while
 * loading or on fetch errors it renders nothing, and a failed dismissal
 * insert still hides the announcement for the session
 * (useDismissAnnouncement is optimistic with no rollback).
 */
export function AnnouncementGate() {
  const { user } = useAuth()
  const { data } = useVisibleAnnouncements(user?.id)
  const dismiss = useDismissAnnouncement(user?.id)
  // One popup per app load: after a dismissal, the next undismissed
  // announcement (if any) waits for the next load instead of stacking.
  const [doneThisLoad, setDoneThisLoad] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(AUTO_CLOSE_SECONDS)

  const announcement = data && !doneThisLoad ? selectVisibleAnnouncement(data.announcements, data.dismissedIds) : null
  const announcementId = announcement?.id
  const { mutate: dismissMutate } = dismiss

  useEffect(() => {
    if (!announcementId) return
    setSecondsLeft(AUTO_CLOSE_SECONDS)
    const interval = setInterval(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearInterval(interval)
  }, [announcementId])

  useEffect(() => {
    if (!announcementId || secondsLeft > 0) return
    setDoneThisLoad(true)
    dismissMutate(announcementId)
  }, [announcementId, secondsLeft, dismissMutate])

  if (!user || !announcement) return null

  const handleDismiss = () => {
    setDoneThisLoad(true)
    dismissMutate(announcement.id)
  }

  return (
    <Modal isOpen onClose={handleDismiss} title={announcement.title} size="sm">
      <div className="space-y-4">
        <Markdown className="text-sm text-[var(--text-secondary)]">{announcement.body_md}</Markdown>
        <div className="flex justify-end">
          <Button onClick={handleDismiss}>
            Got it{secondsLeft > 0 && secondsLeft <= AUTO_CLOSE_SECONDS ? ` (${secondsLeft})` : ''}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
