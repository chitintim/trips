/**
 * Category icon/color mapping, defined once (v1 duplicated this inline in
 * ExpensesTab.tsx, CategoryBreakdown.tsx and SpendingExpenseRow.tsx --
 * consolidated here per coordinator note). Emoji choices match v1 exactly
 * so existing users see the same icons they're used to.
 */
import type { ExpenseCategory } from '../types'

export const CATEGORY_ICONS: Record<ExpenseCategory, string> = {
  accommodation: '🏠',
  transport: '🚗',
  food: '🍽️',
  activities: '⛷️',
  equipment: '🎿',
  other: '📦',
}

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  accommodation: 'Accommodation',
  transport: 'Transport',
  food: 'Food',
  activities: 'Activities',
  equipment: 'Equipment',
  other: 'Other',
}

/** Tailwind background color classes, matching v1's CategoryBreakdown palette. */
export const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  accommodation: 'bg-blue-500',
  transport: 'bg-amber-500',
  food: 'bg-orange-500',
  activities: 'bg-emerald-500',
  equipment: 'bg-purple-500',
  other: 'bg-gray-500',
}

/** Hex equivalents of CATEGORY_COLORS for hand-rolled SVG charts (donut/bars), which can't use Tailwind classes. */
export const CATEGORY_HEX: Record<ExpenseCategory, string> = {
  accommodation: '#3b82f6',
  transport: '#f59e0b',
  food: '#f97316',
  activities: '#10b981',
  equipment: '#a855f7',
  other: '#6b7280',
}

export function categoryIcon(category: string | null | undefined): string {
  return CATEGORY_ICONS[(category as ExpenseCategory) ?? 'other'] ?? '📦'
}

export function categoryLabel(category: string | null | undefined): string {
  return CATEGORY_LABELS[(category as ExpenseCategory) ?? 'other'] ?? 'Other'
}

export const ALL_CATEGORIES: ExpenseCategory[] = [
  'accommodation',
  'transport',
  'food',
  'activities',
  'equipment',
  'other',
]
