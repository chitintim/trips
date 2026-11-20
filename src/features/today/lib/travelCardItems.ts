import { addDays } from '../../../lib/tripWindow'
import { isMainTravelLeg, travelEventFlightRef, getMyExtraTravelLegs } from '../../people/lib/travelDetails'
import { isMyPlanItem } from '../../plan/lib/myPlanItems'
import type { TimelineEvent, TripStatus } from '../../../types'

/** The empty-state prompt only appears this close to the trip. */
export const TRAVEL_PROMPT_WITHIN_DAYS = 90
export const TRAVEL_CARD_MAX_ROWS = 3

export interface TravelCardRow {
  id: string
  date: string
  /** "Today" / "Tomorrow" / "Sun 8 Dec". */
  dateLabel: string
  /** "10:00 local · Flight BA117 · BA117", pieces left out when missing. */
  detail: string
}

export type TravelCardModel =
  | { kind: 'items'; rows: TravelCardRow[] }
  | { kind: 'empty' }
  | { kind: 'none' }

export interface TravelCardInput {
  events: TimelineEvent[]
  userId: string | undefined
  tripStart: string
  tripEnd: string
  /** Local date, YYYY-MM-DD. */
  today: string
  effectiveStage: TripStatus
  /** The viewer is on the trip (confirmed when tracking is on). */
  isComing: boolean
  daysToStart: number
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Pure string maths so a viewer's time zone can never shift the day. */
export function travelDateLabel(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  return `${DAYS[dow]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
}

function isMine(e: TimelineEvent, userId: string): boolean {
  return (e.participant_ids ?? []).includes(userId)
}

function rowDetail(e: TimelineEvent): string {
  const parts: string[] = []
  if (e.start_time && !e.all_day) parts.push(`${e.start_time.slice(0, 5)} local`)
  if (e.title) parts.push(e.title)
  const ref = travelEventFlightRef(e)
  if (ref && !e.title.includes(ref)) parts.push(ref)
  return parts.join(' · ')
}

export function buildTravelCard(input: TravelCardInput): TravelCardModel {
  const { events, userId, tripStart, tripEnd, today, effectiveStage, isComing, daysToStart } = input
  if (!userId || effectiveStage === 'trip_ongoing') return { kind: 'none' }
  const completed = effectiveStage === 'trip_completed'

  const from = today
  const to = completed ? addDays(tripEnd, 7) : addDays(tripStart, -1)

  const extras = getMyExtraTravelLegs(events, userId)
  const extraIds = new Set([...extras.before, ...extras.after].map((e) => e.id))
  const candidates = events.filter(
    (e) => extraIds.has(e.id) || (isMainTravelLeg(e) && isMine(e, userId)) || isMyPlanItem(e, userId),
  )

  const rows = candidates
    .filter((e) => e.event_date >= from && e.event_date <= to)
    // Before the trip nothing inside it belongs here; afterwards only what follows the end.
    .filter((e) => (completed ? e.event_date > tripEnd : e.event_date < tripStart))
    .sort(
      (a, b) =>
        a.event_date.localeCompare(b.event_date) ||
        (a.start_time ?? '').localeCompare(b.start_time ?? '') ||
        a.id.localeCompare(b.id),
    )
    .slice(0, TRAVEL_CARD_MAX_ROWS)
    .map((e) => ({ id: e.id, date: e.event_date, dateLabel: travelDateLabel(e.event_date, today), detail: rowDetail(e) }))

  if (rows.length > 0) return { kind: 'items', rows }

  const hasMainLeg = events.some((e) => isMainTravelLeg(e) && isMine(e, userId))
  if (!completed && isComing && !hasMainLeg && daysToStart <= TRAVEL_PROMPT_WITHIN_DAYS) return { kind: 'empty' }
  return { kind: 'none' }
}
