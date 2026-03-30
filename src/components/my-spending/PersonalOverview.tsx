import { Card } from '../ui'
import { formatCurrency } from '../../lib/currency'
import type { BalanceData } from './MySpendingTab'

interface PersonalOverviewProps {
  myBalance: BalanceData
  totalTripSpend: number
  tripDurationDays: number
  participantCount: number
}

export function PersonalOverview({ myBalance, totalTripSpend, tripDurationDays }: PersonalOverviewProps) {
  const isOwed = myBalance.netBalance > 0.01
  const isOwing = myBalance.netBalance < -0.01
  const sharePercent = totalTripSpend > 0 ? (myBalance.totalOwed / totalTripSpend) * 100 : 0
  const dailyAvg = myBalance.totalOwed / tripDurationDays

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-900 mb-3">Overview</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {/* Total Paid */}
        <Card className="!p-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">I Paid</div>
          <div className="mt-1 text-xl font-bold text-gray-900">
            {formatCurrency(myBalance.totalPaid, 'GBP')}
          </div>
        </Card>

        {/* Total I Owe */}
        <Card className="!p-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">My Share</div>
          <div className="mt-1 text-xl font-bold text-gray-900">
            {formatCurrency(myBalance.totalOwed, 'GBP')}
          </div>
        </Card>

        {/* Net Balance */}
        <Card className="!p-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Net Balance</div>
          <div className={`mt-1 text-xl font-bold ${
            isOwed ? 'text-green-600' : isOwing ? 'text-red-600' : 'text-gray-500'
          }`}>
            {isOwed && '+'}
            {formatCurrency(Math.abs(myBalance.netBalance), 'GBP')}
          </div>
          <div className={`text-xs mt-0.5 ${
            isOwed ? 'text-green-600' : isOwing ? 'text-red-600' : 'text-gray-500'
          }`}>
            {isOwed ? 'Owed to you' : isOwing ? 'You owe' : 'Settled up'}
          </div>
        </Card>

        {/* Share of Trip */}
        <Card className="!p-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Share of Trip</div>
          <div className="mt-1 text-xl font-bold text-gray-900">
            {sharePercent.toFixed(0)}%
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            of {formatCurrency(totalTripSpend, 'GBP')} total
          </div>
        </Card>

        {/* Daily Average */}
        <Card className="!p-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Daily Avg</div>
          <div className="mt-1 text-xl font-bold text-gray-900">
            {formatCurrency(dailyAvg, 'GBP')}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            over {tripDurationDays} days
          </div>
        </Card>
      </div>
    </div>
  )
}
