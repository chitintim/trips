import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Modal, Card, Spinner, EmptyState, Badge } from './ui'
import { formatCurrency } from '../lib/currency'
import { Database } from '../types/database.types'

type Settlement = Database['public']['Tables']['settlements']['Row']
type User = Database['public']['Tables']['users']['Row']

interface SettlementWithUsers extends Settlement {
  from_user: User
  to_user: User
  creator: User
}

interface SettlementHistoryModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
}

export function SettlementHistoryModal({
  isOpen,
  onClose,
  tripId
}: SettlementHistoryModalProps) {
  const [settlements, setSettlements] = useState<SettlementWithUsers[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      fetchSettlements()
    }
  }, [isOpen, tripId])

  const fetchSettlements = async () => {
    setLoading(true)
    setError(null)

    try {
      const { data, error: fetchError } = await supabase
        .from('settlements')
        .select(`
          *,
          from_user:from_user_id (*),
          to_user:to_user_id (*),
          creator:created_by (*)
        `)
        .eq('trip_id', tripId)
        .order('settled_at', { ascending: false })

      if (fetchError) throw fetchError

      setSettlements((data as any) || [])
    } catch (err: any) {
      console.error('Error fetching settlements:', err)
      setError(err.message || 'Failed to load settlement history')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
  }

  const formatTimestamp = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settlement History">
      <div className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : error ? (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        ) : settlements.length === 0 ? (
          <EmptyState
            icon="💸"
            title="No settlements yet"
            description="When people pay each other back, the payments will appear here."
          />
        ) : (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {settlements.map((settlement) => (
              <Card key={settlement.id} className="border-l-4 border-l-green-500">
                <Card.Content className="py-3 px-4">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {/* From User Avatar */}
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-xs flex-shrink-0"
                          style={{
                            backgroundColor: (settlement.from_user.avatar_data as any)?.bgColor || '#0ea5e9',
                          }}
                        >
                          <span className="relative">
                            {(settlement.from_user.avatar_data as any)?.emoji || '😊'}
                          </span>
                        </div>

                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-900">
                            <strong className="font-semibold">
                              {settlement.from_user.full_name || settlement.from_user.email}
                            </strong>
                            {' '}paid{' '}
                            <strong className="font-semibold">
                              {settlement.to_user.full_name || settlement.to_user.email}
                            </strong>
                          </p>
                        </div>
                      </div>

                      {/* Date */}
                      <p className="text-xs text-gray-500 ml-8">
                        {formatDate(settlement.settled_at)}
                      </p>
                    </div>

                    {/* Amount */}
                    <div className="flex-shrink-0">
                      <Badge variant="success" className="text-sm font-bold">
                        {formatCurrency(settlement.amount, 'GBP')}
                      </Badge>
                    </div>
                  </div>

                  {/* Payment Method */}
                  {settlement.payment_method && (
                    <div className="ml-8 mb-1">
                      <span className="text-xs text-gray-600">
                        via <strong>{settlement.payment_method}</strong>
                      </span>
                    </div>
                  )}

                  {/* Notes */}
                  {settlement.notes && (
                    <div className="ml-8 mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                      <p className="text-xs text-gray-700">
                        💬 {settlement.notes}
                      </p>
                    </div>
                  )}

                  {/* Footer - Who recorded it */}
                  <div className="ml-8 mt-2 text-xs text-gray-400">
                    Recorded by {settlement.creator.full_name || settlement.creator.email} on{' '}
                    {formatTimestamp(settlement.created_at || settlement.settled_at)}
                  </div>
                </Card.Content>
              </Card>
            ))}
          </div>
        )}

        {/* Summary Stats */}
        {settlements.length > 0 && (
          <div className="pt-4 border-t border-gray-200">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-green-600">
                  {settlements.length}
                </p>
                <p className="text-xs text-gray-600">
                  Total Payments
                </p>
              </div>
              <div>
                <p className="text-2xl font-bold text-green-600">
                  {formatCurrency(
                    settlements.reduce((sum, s) => sum + s.amount, 0),
                    'GBP'
                  )}
                </p>
                <p className="text-xs text-gray-600">
                  Total Settled
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
