import { Card } from '../ui'
import { formatCurrency } from '../../lib/currency'
import { Database } from '../../types/database.types'
import { TripParticipant, User } from '../../types'

type Settlement = Database['public']['Tables']['settlements']['Row']

interface ParticipantWithUser extends TripParticipant {
  user: User
}

interface SettlementAuditProps {
  settlements: Settlement[]
  userId: string
  participants: ParticipantWithUser[]
}

export function SettlementAudit({ settlements, userId, participants }: SettlementAuditProps) {
  const mySettlements = settlements.filter(
    s => s.from_user_id === userId || s.to_user_id === userId
  )

  if (mySettlements.length === 0) return null

  const getUserName = (id: string): string => {
    if (id === userId) return 'You'
    const p = participants.find(pp => pp.user_id === id)
    return p?.user?.full_name || p?.user?.email || 'Unknown'
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  // Sort by date descending
  const sorted = [...mySettlements].sort(
    (a, b) => new Date(b.settled_at).getTime() - new Date(a.settled_at).getTime()
  )

  const totalPaidOut = sorted
    .filter(s => s.from_user_id === userId)
    .reduce((sum, s) => sum + s.amount, 0)

  const totalReceived = sorted
    .filter(s => s.to_user_id === userId)
    .reduce((sum, s) => sum + s.amount, 0)

  return (
    <div>
      <h2 className="text-lg font-bold text-gray-900 mb-3">Settlements</h2>
      <Card className="!p-4">
        <div className="space-y-2">
          {sorted.map(settlement => {
            const iPaid = settlement.from_user_id === userId
            const counterparty = iPaid
              ? getUserName(settlement.to_user_id)
              : getUserName(settlement.from_user_id)

            return (
              <div
                key={settlement.id}
                className={`flex items-center justify-between p-2 rounded-lg border ${
                  iPaid ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900">
                    {iPaid ? (
                      <>You paid <strong>{counterparty}</strong></>
                    ) : (
                      <><strong>{counterparty}</strong> paid you</>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <span>{formatDate(settlement.settled_at)}</span>
                    {settlement.payment_method && (
                      <>
                        <span>·</span>
                        <span>{settlement.payment_method}</span>
                      </>
                    )}
                    {settlement.notes && (
                      <>
                        <span>·</span>
                        <span className="truncate">{settlement.notes}</span>
                      </>
                    )}
                  </div>
                </div>
                <span className={`font-bold text-sm flex-shrink-0 ml-3 ${
                  iPaid ? 'text-red-600' : 'text-green-600'
                }`}>
                  {iPaid ? '-' : '+'}{formatCurrency(settlement.amount, 'GBP')}
                </span>
              </div>
            )
          })}
        </div>

        {/* Totals */}
        <div className="mt-3 pt-3 border-t border-gray-200 space-y-1">
          {totalPaidOut > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Total paid out</span>
              <span className="font-medium text-red-600">-{formatCurrency(totalPaidOut, 'GBP')}</span>
            </div>
          )}
          {totalReceived > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Total received</span>
              <span className="font-medium text-green-600">+{formatCurrency(totalReceived, 'GBP')}</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
