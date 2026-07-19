import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTrips } from '../../../lib/queries/useTrip'
import { selectVisibleAnnouncement, useVisibleAnnouncements } from '../../announcements'
import {
  hasSeenLandingRedirectPrompt,
  markLandingRedirectPromptSeen,
  selectLandingTrip,
} from '../lib/landing'

const COUNTDOWN_SECONDS = 5

/**
 * Smart landing redirect (dashboard): on the first dashboard landing of a
 * session, offer to jump into the user's closest trip (ongoing first, else
 * nearest future start — selectLandingTrip) behind a 5s countdown.
 * Non-blocking banner, never a modal; once per session
 * (hasSeenLandingRedirectPrompt), so "View all trips" or coming back to the
 * dashboard later never re-triggers it. Any interaction with the banner
 * stops the countdown. Sequencing: if an announcement popup is due, this
 * waits until that layer is settled and clear — the two never show at once.
 */
export function LandingRedirectPrompt() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { data: trips } = useTrips()
  const announcements = useVisibleAnnouncements(user?.id)

  const [open, setOpen] = useState(false)
  const [targetTrip, setTargetTrip] = useState<{ id: string; name: string } | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS)
  const [paused, setPaused] = useState(false)

  // A failed announcements fetch counts as "no announcement" — the popup
  // layer must never block landing.
  const announcementLayerBusy =
    announcements.isLoading ||
    (announcements.data
      ? selectVisibleAnnouncement(announcements.data.announcements, announcements.data.dismissedIds) !== null
      : false)

  useEffect(() => {
    if (open || !user || !trips || announcementLayerBusy) return
    if (hasSeenLandingRedirectPrompt()) return
    const trip = selectLandingTrip(trips, user.id)
    if (!trip) return // no ongoing/upcoming trips → no prompt at all
    markLandingRedirectPromptSeen()
    setTargetTrip({ id: trip.id, name: trip.name })
    setSecondsLeft(COUNTDOWN_SECONDS)
    setOpen(true)
  }, [open, user, trips, announcementLayerBusy])

  useEffect(() => {
    if (!open || paused) return
    const interval = setInterval(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearInterval(interval)
  }, [open, paused])

  useEffect(() => {
    if (!open || paused || secondsLeft > 0 || !targetTrip) return
    navigate(`/${targetTrip.id}`)
  }, [open, paused, secondsLeft, targetTrip, navigate])

  if (!open || !targetTrip) return null

  const stopCountdown = () => setPaused(true)

  return (
    <div
      role="status"
      aria-live="polite"
      onMouseEnter={stopCountdown}
      onFocusCapture={stopCountdown}
      onTouchStart={stopCountdown}
      onPointerDown={stopCountdown}
      className="fixed bottom-4 left-4 right-4 z-toast mx-auto flex max-w-md flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 shadow-lg"
    >
      <p className="min-w-0 text-sm text-[var(--text-primary)]">
        Taking you to <strong className="font-semibold">{targetTrip.name}</strong>
        {paused ? '?' : ` in ${Math.max(secondsLeft, 1)}…`}
      </p>
      <div className="flex shrink-0 gap-2">
        <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
          View all trips
        </Button>
        <Button size="sm" onClick={() => navigate(`/${targetTrip.id}`)}>
          Go now
        </Button>
      </div>
    </div>
  )
}
