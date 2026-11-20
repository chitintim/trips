import type { Json } from './json.ts'

/** Edge-only stand-in for `TimelineEvent` (a `trip_timeline_events` row) in src/types. */
export interface TimelineEvent {
  id: string
  trip_id: string
  title: string
  event_date?: string
  start_time?: string | null
  updated_at?: string | null
  category: string
  metadata: Json | null
  participant_ids: string[] | null
}
