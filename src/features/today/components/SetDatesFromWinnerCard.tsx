import { useMemo } from 'react'
import { Button, Card, useToast } from '../../../components/ui'
import { useUpdateTrip } from '../../../lib/queries/useTrip'
import { useSections, useVotes, useUpdateSection } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer'
import { parseDatesPending, computeDatePollWinner, isDatePollClosed, mergeChaseSettingsJson, TRIP_DATES_SECTION_TITLE } from '../lib/datePoll'
import type { Trip } from '../../../types'

export interface SetDatesFromWinnerCardProps {
  trip: Trip
}

function formatRange(start: string, end: string): string {
  const s = new Date(start + 'T00:00:00')
  const e = new Date(end + 'T00:00:00')
  return `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/**
 * Organizer card shown once the "Trip dates" poll has closed while
 * chase_settings.dates_pending is still set (UX_REDESIGN Part 2): one tap
 * sets the trip's real start/end from the winning range and clears the
 * pending flag.
 */
export function SetDatesFromWinnerCard({ trip }: SetDatesFromWinnerCardProps) {
  const { showToast } = useToast()
  const { data: sections = [] } = useSections(trip.id)
  const { data: votes = [] } = useVotes(trip.id)
  const updateTrip = useUpdateTrip(trip.id)
  const updateSection = useUpdateSection(trip.id)
  const logActivity = useTripActivityLog(trip.id)

  const pending = parseDatesPending(trip.chase_settings)

  const { section, winner } = useMemo(() => {
    if (!pending.pending) return { section: null, winner: null }
    const s =
      sections.find((sec) => sec.id === pending.sectionId) ??
      sections.find((sec) => sec.title === TRIP_DATES_SECTION_TITLE) ??
      null
    if (!s || !isDatePollClosed(s)) return { section: s, winner: null }
    return { section: s, winner: computeDatePollWinner(s, votes) }
  }, [pending.pending, pending.sectionId, sections, votes])

  if (!pending.pending || !section || !winner) return null

  const apply = async () => {
    try {
      await updateTrip.mutateAsync({
        start_date: winner.range.start,
        end_date: winner.range.end,
        chase_settings: mergeChaseSettingsJson(trip.chase_settings, { dates_pending: null, dates_section_id: null }),
      })
      if (section.status !== 'completed') {
        await updateSection.mutateAsync({ id: section.id, update: { status: 'completed' } })
      }
      logActivity({
        verb: 'poll_closed',
        entity: { type: 'section', id: section.id, label: TRIP_DATES_SECTION_TITLE },
        metadata: { winner_start: winner.range.start, winner_end: winner.range.end },
      })
      showToast({ type: 'success', message: 'Trip dates set', description: formatRange(winner.range.start, winner.range.end) })
    } catch (err) {
      showToast({ type: 'error', message: 'Could not set the trip dates', description: (err as Error).message })
    }
  }

  return (
    <Card variant="flat">
      <Card.Content className="py-3 space-y-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">🗓️ The date poll has closed</h3>
        <p className="text-sm text-[var(--text-secondary)]">
          Winning dates: <span className="font-medium text-[var(--text-primary)]">{formatRange(winner.range.start, winner.range.end)}</span>
          {winner.votes > 0 ? ` (${winner.votes} ${winner.votes === 1 ? 'vote' : 'votes'})` : ' (no votes cast — earliest candidate)'}
        </p>
        <Button size="sm" onClick={apply} isLoading={updateTrip.isPending || updateSection.isPending}>
          Set trip dates from winner
        </Button>
      </Card.Content>
    </Card>
  )
}
