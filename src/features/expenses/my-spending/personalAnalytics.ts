/**
 * Personal spending analytics (plan §10 #7): rebuilt My Spending tab data
 * layer. Reuses the same balance math (computeBalances) as the Expenses
 * tab so "my share"/"I paid" figures are consistent everywhere in the app,
 * plus category/day breakdowns specific to this tab's charts.
 */
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { computeBalances } from '../lib/balances'
import { isItemizedExpense, type ExpenseCategory } from '../types'
import { ALL_CATEGORIES } from '../lib/categoryStyle'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'

export interface PersonalOverviewStats {
  totalPaidMajor: number
  myShareMajor: number
  netBalanceMajor: number
  sharePercentOfTrip: number
  dailyAverageMajor: number
  expensesMissingRate: string[]
}

function tripDurationDaysInclusive(startDate: string, endDate: string): number {
  const start = new Date(startDate + 'T00:00:00Z').getTime()
  const end = new Date(endDate + 'T00:00:00Z').getTime()
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1)
}

export function computePersonalOverview(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  allParticipantIds: string[],
  userId: string,
  baseCurrency: string,
  tripStartDate: string,
  tripEndDate: string
): PersonalOverviewStats {
  const { balances, groupTotalMinor, expensesMissingRate } = computeBalances(expenses, settlements, allParticipantIds, baseCurrency)
  const mine = balances.find((b) => b.userId === userId)

  const totalPaidMajor = fromMinorUnits(mine?.totalPaidMinor ?? 0, baseCurrency)
  const myShareMajor = fromMinorUnits(mine?.totalOwedMinor ?? 0, baseCurrency)
  const netBalanceMajor = fromMinorUnits(mine?.netBalanceMinor ?? 0, baseCurrency)
  const sharePercentOfTrip = groupTotalMinor > 0 ? ((mine?.totalOwedMinor ?? 0) / groupTotalMinor) * 100 : 0
  const days = tripDurationDaysInclusive(tripStartDate, tripEndDate)

  return {
    totalPaidMajor,
    myShareMajor,
    netBalanceMajor,
    sharePercentOfTrip,
    dailyAverageMajor: myShareMajor / days,
    expensesMissingRate,
  }
}

export interface CategoryBreakdownEntry {
  category: ExpenseCategory
  myTotalMajor: number
  tripTotalMajor: number
  percentOfMyTotal: number
  diffFromTripAveragePercent: number
}

export function computeCategoryBreakdown(
  expenses: ExpenseWithDetails[],
  userId: string,
  baseCurrency: string
): CategoryBreakdownEntry[] {
  const perCategory = new Map<ExpenseCategory, { myTotalMinor: number; tripTotalMinor: number; usersWithShare: Set<string> }>()
  for (const cat of ALL_CATEGORIES) perCategory.set(cat, { myTotalMinor: 0, tripTotalMinor: 0, usersWithShare: new Set() })

  for (const expense of expenses) {
    const rate = expense.currency === baseCurrency ? 1 : expense.fx_rate
    if (rate == null) continue
    const category = (expense.category as ExpenseCategory) ?? 'other'
    const entry = perCategory.get(category) ?? perCategory.get('other')!

    const tripTotalMinor = toMinorUnits(expense.amount * rate, baseCurrency)
    entry.tripTotalMinor += tripTotalMinor

    if (isItemizedExpense(expense)) {
      for (const claim of expense.claims) entry.usersWithShare.add(claim.user_id)
      const myClaims = expense.claims.filter((c) => c.user_id === userId)
      entry.myTotalMinor += toMinorUnits(myClaims.reduce((s, c) => s + c.amount_owed, 0) * rate, baseCurrency)
    } else {
      for (const split of expense.splits) entry.usersWithShare.add(split.user_id)
      const mySplit = expense.splits.find((s) => s.user_id === userId)
      if (mySplit) entry.myTotalMinor += toMinorUnits(mySplit.amount * rate, baseCurrency)
    }
  }

  const myGrandTotalMinor = Array.from(perCategory.values()).reduce((sum, e) => sum + e.myTotalMinor, 0)

  return ALL_CATEGORIES.map((category) => {
    const entry = perCategory.get(category)!
    const usersInCategory = entry.usersWithShare.size || 1
    const tripAvgPerPersonMinor = entry.tripTotalMinor / usersInCategory
    const diff = tripAvgPerPersonMinor > 0 ? ((entry.myTotalMinor - tripAvgPerPersonMinor) / tripAvgPerPersonMinor) * 100 : 0

    return {
      category,
      myTotalMajor: fromMinorUnits(entry.myTotalMinor, baseCurrency),
      tripTotalMajor: fromMinorUnits(entry.tripTotalMinor, baseCurrency),
      percentOfMyTotal: myGrandTotalMinor > 0 ? (entry.myTotalMinor / myGrandTotalMinor) * 100 : 0,
      diffFromTripAveragePercent: diff,
    }
  }).filter((e) => e.myTotalMajor > 0 || e.tripTotalMajor > 0)
}

export interface DayBreakdownEntry {
  date: string
  label: string
  myTotalMajor: number
  tripTotalMajor: number
}

export function computeDayBreakdown(
  expenses: ExpenseWithDetails[],
  userId: string,
  baseCurrency: string,
  tripStartDate: string,
  tripEndDate: string
): DayBreakdownEntry[] {
  const byDate = new Map<string, { myMinor: number; tripMinor: number }>()

  const start = new Date(tripStartDate + 'T00:00:00Z')
  const end = new Date(tripEndDate + 'T00:00:00Z')
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    byDate.set(d.toISOString().slice(0, 10), { myMinor: 0, tripMinor: 0 })
  }

  for (const expense of expenses) {
    const rate = expense.currency === baseCurrency ? 1 : expense.fx_rate
    if (rate == null) continue
    const entry = byDate.get(expense.payment_date) ?? { myMinor: 0, tripMinor: 0 }
    entry.tripMinor += toMinorUnits(expense.amount * rate, baseCurrency)

    if (isItemizedExpense(expense)) {
      const myClaims = expense.claims.filter((c) => c.user_id === userId)
      entry.myMinor += toMinorUnits(myClaims.reduce((s, c) => s + c.amount_owed, 0) * rate, baseCurrency)
    } else {
      const mySplit = expense.splits.find((s) => s.user_id === userId)
      if (mySplit) entry.myMinor += toMinorUnits(mySplit.amount * rate, baseCurrency)
    }
    byDate.set(expense.payment_date, entry)
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v], i) => ({
      date,
      label: `Day ${i + 1}`,
      myTotalMajor: fromMinorUnits(v.myMinor, baseCurrency),
      tripTotalMajor: fromMinorUnits(v.tripMinor, baseCurrency),
    }))
}

export interface PaidVsOwedEntry {
  userId: string
  name: string
  paidMajor: number
  owedMajor: number
}

export function computePaidVsOwed(
  expenses: ExpenseWithDetails[],
  settlements: Settlement[],
  people: Array<{ userId: string; name: string }>,
  baseCurrency: string
): PaidVsOwedEntry[] {
  const { balances } = computeBalances(expenses, settlements, people.map((p) => p.userId), baseCurrency)
  return people.map((p) => {
    const b = balances.find((x) => x.userId === p.userId)
    return {
      userId: p.userId,
      name: p.name,
      paidMajor: fromMinorUnits(b?.totalPaidMinor ?? 0, baseCurrency),
      owedMajor: fromMinorUnits(b?.totalOwedMinor ?? 0, baseCurrency),
    }
  })
}
