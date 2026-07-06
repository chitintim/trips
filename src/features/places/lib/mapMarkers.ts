import type { TimelineEventCategory } from '../../../types'

/**
 * Day-color palette for itinerary markers/polylines. Cycles for trips longer
 * than the palette (uncommon, but graceful). Chosen from the accent-safe
 * categorical set (distinguishable in both light/dark, not reliant on the
 * per-trip accent hue since that would clash with same-hue markers).
 */
export const DAY_COLORS = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#d97706', // amber
  '#9333ea', // purple
  '#0891b2', // cyan
  '#db2777', // pink
  '#65a30d', // lime
  '#ea580c', // orange
  '#4f46e5', // indigo
]

export function colorForDayIndex(index: number): string {
  return DAY_COLORS[index % DAY_COLORS.length]
}

/** Emoji per timeline event category, used inside itinerary map markers. */
const TIMELINE_CATEGORY_EMOJI: Record<TimelineEventCategory, string> = {
  flight: '✈️',
  accommodation: '🏠',
  transport: '🚗',
  activity: '⛷️',
  dining: '🍽️',
  transfer: '🚌',
  meeting_point: '📍',
  free_time: '🕐',
  other: '📌',
}

export function timelineCategoryEmoji(category: string | null | undefined): string {
  return TIMELINE_CATEGORY_EMOJI[(category as TimelineEventCategory) ?? 'other'] ?? '📌'
}

/** Marker style for planning options (accommodation/activity being compared). */
export const OPTION_MARKER_COLOR = '#7c3aed' // purple — distinct from day colors & money markers
export const OPTION_MARKER_EMOJI = '🏨'

/** Marker style for expenses (money spent) pins. */
export const EXPENSE_MARKER_COLOR = '#059669' // green — reads as "money"
export const EXPENSE_MARKER_EMOJI = '💵'
