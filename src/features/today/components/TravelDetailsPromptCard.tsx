import { useState } from 'react'
import { Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { TravelDetailsSheet, getMyTravelEvents } from '../../people'

/**
 * "Your arrival details" prompt (awaiting-departure Today layout): shown
 * while the user's own travel-details events are missing.
 */
export function TravelDetailsPromptCard({ tripId }: { tripId: string }) {
  const { user } = useAuth()
  const { data: events = [] } = useTimeline(tripId)
  const [sheetOpen, setSheetOpen] = useState(false)

  const mine = getMyTravelEvents(events, user?.id)
  if (mine.arrival && mine.departure) return null

  return (
    <>
      <Card>
        <Card.Content className="flex items-center justify-between gap-3 py-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">✈️ When do you arrive?</h3>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">
              Add your travel details so pickups and night-by-night costs work out.
            </p>
          </div>
          <Button size="sm" onClick={() => setSheetOpen(true)}>
            Add
          </Button>
        </Card.Content>
      </Card>
      <TravelDetailsSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} tripId={tripId} />
    </>
  )
}
