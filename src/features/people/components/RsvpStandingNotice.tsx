import { Button } from '../../../components/ui'
import type { RsvpAnswer } from '../lib/rsvpAnswers'
import { rsvpStandingLine, type RsvpStanding } from '../lib/rsvpStanding'
import { standingReplacesAnswerButton } from '../lib/peopleSummary'
import { STILL_COMING_LABEL, OUT_LABEL } from '../lib/replyBy'

export interface RsvpStandingNoticeProps {
  standing: RsvpStanding
  tripName: string
  /** Opens the RSVP sheet with this answer preselected. */
  onAnswer: (answer: RsvpAnswer) => void
}

/**
 * The calm explanation shown instead of "Update my answer" when you are down
 * as not sure (or never replied) and the trip is full or replies have closed.
 * Nothing is asked of you; the buttons are there if you want to say something.
 * Returns null when the standing has no such line.
 */
export function RsvpStandingNotice({ standing, tripName, onAnswer }: RsvpStandingNoticeProps) {
  const line = rsvpStandingLine(standing, tripName)
  if (!line) return null
  // A freed place goes to the waitlist first, so "I'd still like to come" would jump the queue.
  const canJoin = !standing.placeHeld
  return (
    <div className="space-y-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3" data-rsvp-standing={standing.kind}>
      <div className="space-y-1">
        <p className="text-sm text-[var(--text-primary)]">{line.text}</p>
        {line.detail && <p className="text-sm text-[var(--text-secondary)]">{line.detail}</p>}
      </div>
      {standingReplacesAnswerButton(standing) && (
        <div className="flex flex-col gap-2 sm:flex-row">
          {canJoin && (
            <Button variant="secondary" fullWidth onClick={() => onAnswer('in')}>
              {STILL_COMING_LABEL}
            </Button>
          )}
          <Button variant="outline" fullWidth onClick={() => onAnswer('out')}>
            {OUT_LABEL}
          </Button>
        </div>
      )}
    </div>
  )
}
