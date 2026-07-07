import { useMemo } from 'react'
import { Card, Badge } from '../../../components/ui'
import { usePlanItems } from '../../plan'
import type { PlanItem } from '../../plan'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { PlaceChip, googleMapsDirectionsUrl } from '../../places'
import { formatTime } from '../../timeline'
import type { Trip } from '../../../types'

export interface NowNextCardProps {
  trip: Trip
}

function toDateOnly(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * NOW/NEXT card (ongoing Today layout): the current plan item and the next
 * one coming up, each with its place chip and a Directions deep link. Times
 * are destination-local naive — no TZ conversion (UX_REDESIGN Part 3 §8).
 */
export function NowNextCard({ trip }: NowNextCardProps) {
  const { items } = usePlanItems(trip.id)
  const { data: places = [] } = usePlaces(trip.id)

  const { now, next } = useMemo(() => {
    const today = toDateOnly(new Date())
    const nowTime = new Date().toTimeString().slice(0, 8)

    const dated = items
      .filter((i) => (i.stage === 'decided' || i.stage === 'booked') && i.date)
      .sort((a, b) => (a.date! + (a.startTime ?? '')).localeCompare(b.date! + (b.startTime ?? '')))

    let nowItem: PlanItem | null = null
    let nextItem: PlanItem | null = null
    for (const item of dated) {
      if (item.date! < today) continue
      if (item.date! === today && item.startTime && item.startTime <= nowTime) {
        // Started already — the latest such item is "now" unless it clearly ended.
        if (!item.endTime || item.endTime > nowTime || item.endTime < item.startTime /* overnight */) {
          nowItem = item
        }
        continue
      }
      nextItem = item
      break
    }
    return { now: nowItem, next: nextItem }
  }, [items])

  if (!now && !next) return null

  const renderItem = (item: PlanItem, label: 'NOW' | 'NEXT') => {
    const place = item.placeId ? places.find((p) => p.id === item.placeId) : null
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Badge variant={label === 'NOW' ? 'success' : 'info'} size="sm">
            {label}
          </Badge>
          <span className="text-xs text-[var(--text-muted)]">
            {item.date === toDateOnly(new Date()) ? '' : new Date(item.date!).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' '}
            {item.startTime ? `${formatTime(item.startTime)} local` : 'anytime'}
          </span>
        </div>
        <p className="font-semibold text-[var(--text-primary)]">{item.title}</p>
        {place && (
          <div className="flex items-center gap-2 flex-wrap">
            <PlaceChip place={place} compact />
            <a
              href={googleMapsDirectionsUrl(place)}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-accent-700 hover:underline"
            >
              Directions →
            </a>
          </div>
        )}
      </div>
    )
  }

  return (
    <Card>
      <Card.Content className="space-y-4">
        {now && renderItem(now, 'NOW')}
        {next && renderItem(next, 'NEXT')}
      </Card.Content>
    </Card>
  )
}
