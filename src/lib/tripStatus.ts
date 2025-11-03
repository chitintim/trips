import { Database } from '../types/database.types'

export type TripStatus = Database['public']['Enums']['trip_status']

export type BadgeVariant = 'info' | 'success' | 'warning' | 'error' | 'neutral'

/**
 * Get badge variant for a trip status
 */
export function getTripStatusBadgeVariant(status: TripStatus): BadgeVariant {
  switch (status) {
    case 'gathering_interest':
      return 'warning' // Yellow - early stages
    case 'confirming_participants':
      return 'warning' // Yellow - still gathering commitments
    case 'booking_details':
      return 'info' // Blue - actively planning/booking
    case 'booked_awaiting_departure':
      return 'success' // Green - ready to go!
    case 'trip_ongoing':
      return 'info' // Blue - happening now
    case 'trip_completed':
      return 'neutral' // Gray - all done
    default:
      return 'neutral'
  }
}

/**
 * Get display label for a trip status
 */
export function getTripStatusLabel(status: TripStatus): string {
  switch (status) {
    case 'gathering_interest':
      return 'Gathering Interest'
    case 'confirming_participants':
      return 'Confirming Participants'
    case 'booking_details':
      return 'Booking Details'
    case 'booked_awaiting_departure':
      return 'Booked'
    case 'trip_ongoing':
      return 'Ongoing'
    case 'trip_completed':
      return 'Completed'
    default:
      return status
  }
}

/**
 * Check if trip options should be locked (cannot be edited)
 */
export function isTripLocked(status: TripStatus): boolean {
  return status === 'booked_awaiting_departure' || status === 'trip_ongoing' || status === 'trip_completed'
}

/**
 * Get trip timing information based on dates
 * Returns an object with label and badge variant
 */
export function getTripTiming(startDate: string, endDate: string): {
  label: string
  variant: BadgeVariant
} | null {
  const today = new Date()
  today.setHours(0, 0, 0, 0) // Reset to start of day for accurate comparison

  const start = new Date(startDate)
  start.setHours(0, 0, 0, 0)

  const end = new Date(endDate)
  end.setHours(23, 59, 59, 999) // Set to end of day

  // Trip is ongoing
  if (today >= start && today <= end) {
    return {
      label: 'Happening Now',
      variant: 'info'
    }
  }

  // Trip is completed
  if (today > end) {
    return {
      label: 'Completed',
      variant: 'neutral'
    }
  }

  // Trip is upcoming - calculate days until departure
  const daysUntil = Math.ceil((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  if (daysUntil === 0) {
    return {
      label: 'Departing Today',
      variant: 'warning'
    }
  } else if (daysUntil === 1) {
    return {
      label: 'Tomorrow',
      variant: 'warning'
    }
  } else if (daysUntil <= 7) {
    return {
      label: `${daysUntil} days away`,
      variant: 'warning'
    }
  } else if (daysUntil <= 30) {
    return {
      label: `${daysUntil} days away`,
      variant: 'info'
    }
  } else {
    // More than 30 days away - show neutral badge with days remaining
    return {
      label: `${daysUntil} days away`,
      variant: 'neutral'
    }
  }
}
