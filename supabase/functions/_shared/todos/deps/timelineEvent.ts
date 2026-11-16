import type { Json } from './json.ts'

/** Edge-only stand-in for `TimelineEvent` (a `trip_timeline_events` row) in src/types. */
export interface TimelineEvent {
  id: string
  trip_id: string
  title: string
  category: string
  metadata: Json | null
  participant_ids: string[] | null
}
