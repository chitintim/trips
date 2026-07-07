import { lazy, Suspense, useState } from 'react'
import { Button, SegmentedControl, Skeleton } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useParticipants } from '../../../lib/queries/useTrip'
import { usePlanItems } from '../lib/usePlanItems'
import type { PlanItem } from '../lib/planItems'
import { PlanBoard } from './PlanBoard'
import { PlanDecideLens } from './PlanDecideLens'
import { PlanItemSheet } from './PlanItemSheet'
import { AddToPlanSheet } from './AddToPlanSheet'
import { ScheduleItSheet } from './ScheduleItSheet'
import type { Trip } from '../../../types'

type Lens = 'list' | 'map' | 'decide'

// The Map lens pulls in react-leaflet/leaflet (~2.7MB). Now that the Plan
// space is wired eagerly into TripDetail (v2.1 four-space nav), the lens is
// lazy-loaded so leaflet stays out of the main chunk until a user actually
// switches to Map — same treatment TripMapTab always had.
const LazyPlanMapLens = lazy(() => import('./PlanMapLens').then((m) => ({ default: m.PlanMapLens })))

export interface PlanTabProps {
  trip: Trip
  /** Cross-space links, e.g. tapping a linked-expense chip to jump to Money. */
  onNavigate?: (tabId: string, params?: { expenseId?: string }) => void
}

/**
 * The unified Plan surface (UX_REDESIGN.md §2): one PlanItem[] composed by
 * usePlanItems, rendered through three lenses (List/Map/Decide) via a
 * sticky segmented control, with one detail sheet and one creation sheet
 * shared across all of them.
 */
export function PlanTab({ trip, onNavigate }: PlanTabProps) {
  const { user } = useAuth()
  const { data: participants } = useParticipants(trip.id)
  const { items, isLoading } = usePlanItems(trip.id)

  const [lens, setLens] = useState<Lens>('list')
  const [selectedItem, setSelectedItem] = useState<PlanItem | null>(null)
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const [addSheetDefaultIsVote, setAddSheetDefaultIsVote] = useState(false)
  const [scheduleItem, setScheduleItem] = useState<PlanItem | null>(null)

  const openAddSheet = (defaultIsVote = false) => {
    setAddSheetDefaultIsVote(defaultIsVote)
    setAddSheetOpen(true)
  }

  const myParticipant = participants?.find((p) => p.user_id === user?.id)
  const isOrganizer = myParticipant?.role === 'organizer'
  const confirmedCount = (participants || []).filter((p) => p.confirmation_status === 'confirmed').length

  const handleNavigateToExpense = (expenseId: string) => {
    setSelectedItem(null)
    onNavigate?.('money', { expenseId })
  }

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton variant="card" height={48} />
        <Skeleton variant="card" height={120} />
        <Skeleton variant="card" height={120} />
      </div>
    )
  }

  return (
    <div className="relative space-y-4 p-4 max-w-3xl mx-auto">
      <div className="sticky top-0 z-30 -mx-4 px-4 pb-2 bg-[var(--surface-page)]/95 backdrop-blur-sm flex items-center justify-between gap-3">
        <SegmentedControl
          value={lens}
          onChange={(v) => setLens(v)}
          options={[
            { value: 'list', label: 'List', icon: '📋' },
            { value: 'map', label: 'Map', icon: '🗺️' },
            { value: 'decide', label: 'Decide', icon: '🗳️' },
          ]}
        />
        <Button size="sm" onClick={() => openAddSheet(false)}>
          + Add
        </Button>
      </div>

      {lens === 'list' && (
        <PlanBoard
          trip={trip}
          items={items}
          isOrganizer={isOrganizer}
          onOpenItem={setSelectedItem}
          onScheduleIt={setScheduleItem}
          onNewQuestion={() => openAddSheet(true)}
        />
      )}
      {lens === 'map' && (
        <Suspense fallback={<Skeleton variant="card" height={420} />}>
          <LazyPlanMapLens trip={trip} items={items} onOpenItem={setSelectedItem} />
        </Suspense>
      )}
      {lens === 'decide' && <PlanDecideLens trip={trip} />}

      <PlanItemSheet
        isOpen={!!selectedItem}
        onClose={() => setSelectedItem(null)}
        trip={trip}
        item={selectedItem}
        isOrganizer={isOrganizer}
        confirmedCount={confirmedCount}
        onNavigateToExpense={onNavigate ? handleNavigateToExpense : undefined}
        onScheduleIt={(item) => {
          setSelectedItem(null)
          setScheduleItem(item)
        }}
      />

      <AddToPlanSheet
        isOpen={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        trip={trip}
        defaultIsVote={addSheetDefaultIsVote}
      />

      <ScheduleItSheet isOpen={!!scheduleItem} onClose={() => setScheduleItem(null)} trip={trip} item={scheduleItem} />
    </div>
  )
}
