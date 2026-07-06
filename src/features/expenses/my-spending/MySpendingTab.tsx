import { useMemo } from 'react'
import { Card, StatCard, Skeleton, Badge } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { formatMoney } from '../lib/formatMoney'
import { computePersonalOverview, computeCategoryBreakdown, computeDayBreakdown, computePaidVsOwed } from './personalAnalytics'
import { CategoryDonutChart } from './CategoryDonutChart'
import { DayByDayBarChart } from './DayByDayBarChart'
import { PaidVsOwedChart } from './PaidVsOwedChart'
import { ReceiptGallery } from './ReceiptGallery'
import type { Trip } from '../../../types'

export interface MySpendingTabProps {
  trip: Trip
}

/**
 * My Spending tab (plan §10 #7): personal analytics rebuilt with StatCards
 * + hand-rolled SVG charts (no chart library) + receipt gallery lightbox.
 */
export function MySpendingTab({ trip }: MySpendingTabProps) {
  const { user } = useAuth()
  const { data, isLoading } = useExpenses(trip.id)
  const { data: participants = [] } = useParticipants(trip.id)

  const expenses = data?.expenses ?? []
  const settlements = data?.settlements ?? []
  const people = participants.map((p) => ({ userId: p.user_id, name: p.user.full_name || p.user.email }))

  const overview = useMemo(
    () =>
      user
        ? computePersonalOverview(expenses, settlements, people.map((p) => p.userId), user.id, trip.base_currency, trip.start_date, trip.end_date)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expenses, settlements, people, user, trip.base_currency, trip.start_date, trip.end_date]
  )

  const categoryBreakdown = useMemo(
    () => (user ? computeCategoryBreakdown(expenses, user.id, trip.base_currency) : []),
    [expenses, user, trip.base_currency]
  )

  const dayBreakdown = useMemo(
    () => (user ? computeDayBreakdown(expenses, user.id, trip.base_currency, trip.start_date, trip.end_date) : []),
    [expenses, user, trip.base_currency, trip.start_date, trip.end_date]
  )

  const paidVsOwed = useMemo(
    () => computePaidVsOwed(expenses, settlements, people, trip.base_currency),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expenses, settlements, people, trip.base_currency]
  )

  if (isLoading || !overview) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" height={100} />
        <Skeleton variant="card" height={200} />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="I paid" value={formatMoney(overview.totalPaidMajor, trip.base_currency)} size="sm" />
        <StatCard label="My share" value={formatMoney(overview.myShareMajor, trip.base_currency)} size="sm" />
        <StatCard
          label="Net balance"
          value={formatMoney(Math.abs(overview.netBalanceMajor), trip.base_currency)}
          delta={overview.netBalanceMajor >= 0 ? 'owed to you' : 'you owe'}
          deltaDirection={overview.netBalanceMajor >= 0 ? 'up' : 'down'}
          size="sm"
        />
        <StatCard label="Daily average" value={formatMoney(overview.dailyAverageMajor, trip.base_currency)} size="sm" />
      </div>

      {overview.expensesMissingRate.length > 0 && (
        <Badge variant="warning">
          ⚠️ {overview.expensesMissingRate.length} expense{overview.expensesMissingRate.length === 1 ? '' : 's'} missing FX rates — excluded above
        </Badge>
      )}

      <Card>
        <Card.Title>Spending by category</Card.Title>
        <Card.Content>
          <CategoryDonutChart entries={categoryBreakdown} currency={trip.base_currency} />
        </Card.Content>
      </Card>

      <Card>
        <Card.Title>Spend per day</Card.Title>
        <Card.Content>
          <DayByDayBarChart entries={dayBreakdown} currency={trip.base_currency} />
        </Card.Content>
      </Card>

      <Card>
        <Card.Title>Paid vs owed, by person</Card.Title>
        <Card.Content>
          <PaidVsOwedChart entries={paidVsOwed} currency={trip.base_currency} />
        </Card.Content>
      </Card>

      <Card>
        <Card.Title>Receipts</Card.Title>
        <Card.Content>
          <ReceiptGallery expenses={expenses} />
        </Card.Content>
      </Card>
    </div>
  )
}
