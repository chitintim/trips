import { useMemo, useState } from 'react'
import { EmptyState } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections, useToggleVote } from '../../../lib/queries/usePlanning'
import { getOpenVotables } from '../lib/planItems'
import { PlanItemCard } from './PlanItemCard'
import type { PlanItem } from '../lib/planItems'
import type { Trip } from '../../../types'

export interface PlanDecideLensProps {
  trip: Trip
  items: PlanItem[]
  onOpenItem: (item: PlanItem) => void
}

/**
 * Decide lens (plan §2): "only open votables sorted by deadline — the do
 * your homework view". Reuses the same PlanItemCard so voting affordances
 * are consistent with the List lens; a second tap on an already-voted card
 * opens the detail sheet (same convention as PlanBoard).
 */
export function PlanDecideLens({ trip, items, onOpenItem }: PlanDecideLensProps) {
  const { user } = useAuth()
  const { data: places } = usePlaces(trip.id)
  const { data: sections } = useSections(trip.id)
  const toggleVote = useToggleVote(trip.id)
  const [votingId, setVotingId] = useState<string | null>(null)

  const placesById = useMemo(() => new Map((places || []).map((p) => [p.id, p])), [places])
  const votables = useMemo(() => getOpenVotables(items), [items])

  const handleVote = (item: PlanItem) => {
    if (!user || !item.optionId || !item.vote) return
    const optionSection = (sections || []).find((s) => s.id === item.sectionId)
    const option = optionSection?.options.find((o) => o.id === item.optionId)
    if (option?.locked) return
    if (item.vote.myVote.voted) {
      onOpenItem(item)
      return
    }
    setVotingId(item.id)
    toggleVote.mutate({ optionId: item.optionId, userId: user.id, action: 'add' }, { onSettled: () => setVotingId(null) })
  }

  if (votables.length === 0) {
    return <EmptyState icon="🎉" title="Nothing needs deciding" description="Every open poll has been voted on or closed. Nice work." />
  }

  return (
    <div className="space-y-3">
      {votables.map((item) => (
        <PlanItemCard
          key={item.id}
          item={item}
          place={item.placeId ? placesById.get(item.placeId) : undefined}
          onOpen={onOpenItem}
          onVote={handleVote}
          isVoting={votingId === item.id}
          myVoted={item.vote?.myVote.voted}
        />
      ))}
    </div>
  )
}
