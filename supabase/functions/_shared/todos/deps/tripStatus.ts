/** Edge-only stand-in for `TripStatus` (src/lib/tripStatus.ts); same union as the `trip_status` DB enum. */
export type TripStatus =
  | 'gathering_interest'
  | 'confirming_participants'
  | 'booking_details'
  | 'booked_awaiting_departure'
  | 'trip_ongoing'
  | 'trip_completed'
