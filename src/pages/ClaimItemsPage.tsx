import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Button, Spinner, Badge } from '../components/ui'
import { formatCurrency, type Currency } from '../lib/currency'
import type { Database } from '../types/database.types'

type ExpenseLineItem = Database['public']['Tables']['expense_line_items']['Row']
type ExpenseItemClaim = Database['public']['Tables']['expense_item_claims']['Row']
type Expense = Database['public']['Tables']['expenses']['Row']
type AllocationLink = Database['public']['Tables']['expense_allocation_links']['Row']

interface LineItemWithClaims extends ExpenseLineItem {
  claims: (ExpenseItemClaim & {
    user: {
      id: string
      full_name: string
      avatar_url: string | null
      avatar_data?: any
    }
  })[]
  availableQuantity: number
}

interface ClaimSelection {
  lineItemId: string
  quantity: number
  amount: number
}

export function ClaimItemsPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Data
  const [allocationLink, setAllocationLink] = useState<AllocationLink | null>(null)
  const [expense, setExpense] = useState<Expense | null>(null)
  const [lineItems, setLineItems] = useState<LineItemWithClaims[]>([])
  const [paidByUser, setPaidByUser] = useState<any>(null)

  // User selections
  const [selections, setSelections] = useState<Record<string, ClaimSelection>>({})

  // Auto-save state
  const [saving, setSaving] = useState(false)
  const [saveTimer, setSaveTimer] = useState<NodeJS.Timeout | null>(null)

  // Other users' live selections (broadcast)
  const [_otherUsersSelections, setOtherUsersSelections] = useState<Record<string, {
    userId: string
    userName: string
    selections: Record<string, ClaimSelection>
  }>>({})

  // Store channel reference for broadcasting
  const [broadcastChannel, setBroadcastChannel] = useState<any>(null)
  const [currentUserProfile, setCurrentUserProfile] = useState<any>(null)

  // Cache of all trip participants (for displaying avatars in optimistic claims)
  const usersCacheRef = useRef<Record<string, any>>({})

  useEffect(() => {
    loadClaimData()
  }, [code, user])

  // Broadcast selections to other users when they change (instant feedback)
  useEffect(() => {
    if (!broadcastChannel || !user || !expense || !currentUserProfile) return

    // Broadcast current selections
    broadcastChannel.send({
      type: 'broadcast',
      event: 'selection_change',
      payload: {
        userId: user.id,
        userName: currentUserProfile.full_name || user.email,
        selections
      }
    })

    console.log('📤 Broadcasting selections to other users')
  }, [selections, broadcastChannel, user, expense, currentUserProfile])

  // Auto-save selections with debouncing (1 second delay)
  useEffect(() => {
    if (!expense || !user) return

    // Clear existing timer
    if (saveTimer) {
      clearTimeout(saveTimer)
    }

    // Set new timer to auto-save after 1 second of no changes
    const timer = setTimeout(() => {
      autoSaveClaims()
    }, 1000)

    setSaveTimer(timer)

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [selections])

  // Real-time subscription: postgres_changes + broadcasts
  useEffect(() => {
    if (!expense || !user) return

    console.log('✅ Setting up real-time subscription for expense:', expense.id)

    const channel = supabase
      .channel(`expense_claims:${expense.id}`, {
        config: {
          broadcast: { self: false } // Don't receive our own broadcasts
        }
      })
      // Listen for database changes (when users save)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'expense_item_claims',
          filter: `expense_id=eq.${expense.id}`
        },
        (payload: any) => {
          console.log('🔔 Claim saved (database):', payload)
          // Reload to show confirmed claims
          loadClaimData()
        }
      )
      // Listen for live selection broadcasts (instant updates)
      .on(
        'broadcast',
        { event: 'selection_change' },
        (payload) => {
          console.log('👀 Live selection from another user:', payload)
          const { userId, userName, selections: userSelections } = payload.payload

          // Store the broadcast selections
          setOtherUsersSelections(prev => ({
            ...prev,
            [userId]: {
              userId,
              userName,
              selections: userSelections
            }
          }))

          // Optimistically update lineItems to show the other user's selections immediately
          setLineItems(prevItems => {
            return prevItems.map(item => {
              // Get this user's selection for this item
              const userSelection = userSelections[item.id]

              // Remove any existing optimistic claims from this user
              const filteredClaims = item.claims.filter(c => c.user_id !== userId)

              // If user has a selection for this item, add it as an optimistic claim
              if (userSelection && userSelection.quantity > 0) {
                // Get user data from cache for proper avatar display
                const cachedUser = usersCacheRef.current[userId]

                const optimisticClaim = {
                  id: `temp-${userId}-${item.id}`,
                  line_item_id: item.id,
                  user_id: userId,
                  expense_id: expense?.id || '',
                  quantity_claimed: userSelection.quantity,
                  amount_owed: userSelection.amount,
                  confirmed: false,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  user: cachedUser || {
                    id: userId,
                    full_name: userName,
                    avatar_url: null,
                    avatar_data: null
                  }
                }

                // Calculate new available quantity
                const totalClaimed = [...filteredClaims, optimisticClaim].reduce(
                  (sum, c) => sum + Number(c.quantity_claimed),
                  0
                )
                const available = Number(item.quantity) - totalClaimed

                return {
                  ...item,
                  claims: [...filteredClaims, optimisticClaim] as any,
                  availableQuantity: available
                }
              } else {
                // User has no selection, just recalculate available
                const totalClaimed = filteredClaims.reduce((sum, c) => sum + Number(c.quantity_claimed), 0)
                const available = Number(item.quantity) - totalClaimed

                return {
                  ...item,
                  claims: filteredClaims,
                  availableQuantity: available
                }
              }
            })
          })
        }
      )
      .subscribe((status) => {
        console.log('📡 Subscription status:', status)
        if (status === 'SUBSCRIBED') {
          setBroadcastChannel(channel)
        }
      })

    return () => {
      console.log('🔴 Cleaning up real-time subscription')
      setBroadcastChannel(null)
      supabase.removeChannel(channel)
    }
  }, [expense, user])

  const loadClaimData = async () => {
    if (!code) {
      setError('Invalid claim link')
      setLoading(false)
      return
    }

    if (!user) {
      // Still loading auth
      return
    }

    setLoading(true)
    setError(null)

    try {
      // 1. Load allocation link
      const { data: link, error: linkError } = await supabase
        .from('expense_allocation_links')
        .select('*')
        .eq('code', code)
        .single()

      if (linkError) throw new Error('Invalid or expired claim link')
      if (!link) throw new Error('Claim link not found')

      // 2. Check expiry
      const now = new Date()
      const expiresAt = new Date(link.expires_at)
      if (now > expiresAt) {
        throw new Error('This claim link has expired')
      }

      setAllocationLink(link)

      // 3. Check user is trip participant
      const { data: participant, error: participantError } = await supabase
        .from('trip_participants')
        .select('*')
        .eq('trip_id', link.trip_id)
        .eq('user_id', user.id)
        .single()

      if (participantError || !participant) {
        throw new Error('You must be a trip participant to claim items')
      }

      // 4. Load expense
      const { data: expenseData, error: expenseError } = await supabase
        .from('expenses')
        .select('*')
        .eq('id', link.expense_id)
        .single()

      if (expenseError) throw expenseError
      if (!expenseData) throw new Error('Expense not found')

      setExpense(expenseData)

      // 5. Load paid_by user separately
      const { data: paidByUserData, error: userError } = await supabase
        .from('users')
        .select('id, full_name, avatar_url, avatar_data')
        .eq('id', expenseData.paid_by)
        .single()

      if (!userError && paidByUserData) {
        setPaidByUser(paidByUserData)
      }

      // 5b. Load current user's profile for broadcasting
      const { data: currentUserData } = await supabase
        .from('users')
        .select('id, full_name, avatar_url, avatar_data')
        .eq('id', user.id)
        .single()

      if (currentUserData) {
        setCurrentUserProfile(currentUserData)
      }

      // 5c. Load all trip participants for avatar cache
      const { data: participants } = await supabase
        .from('trip_participants')
        .select('user_id')
        .eq('trip_id', link.trip_id)

      if (participants && participants.length > 0) {
        const participantIds = participants.map(p => p.user_id)
        const { data: participantUsers } = await supabase
          .from('users')
          .select('id, full_name, avatar_url, avatar_data')
          .in('id', participantIds)

        if (participantUsers) {
          const cache: Record<string, any> = {}
          participantUsers.forEach(u => {
            cache[u.id] = u
          })
          usersCacheRef.current = cache
        }
      }

      // 6. Load line items
      const { data: items, error: itemsError } = await supabase
        .from('expense_line_items')
        .select('*')
        .eq('expense_id', link.expense_id)
        .order('line_number')

      if (itemsError) throw itemsError

      // 7. Load existing claims for these items
      const { data: claims, error: claimsError } = await supabase
        .from('expense_item_claims')
        .select('*')
        .eq('expense_id', link.expense_id)

      if (claimsError) throw claimsError

      // 8. Load users for claims separately to avoid RLS issues
      const claimUserIds = [...new Set((claims || []).map(c => c.user_id))]
      let claimUsers: any[] = []

      if (claimUserIds.length > 0) {
        const { data: usersData } = await supabase
          .from('users')
          .select('id, full_name, avatar_url, avatar_data')
          .in('id', claimUserIds)

        claimUsers = usersData || []
      }

      // 9. Calculate available quantities and attach claims with user data
      const itemsWithClaims: LineItemWithClaims[] = (items || []).map(item => {
        const itemClaims = (claims || [])
          .filter(c => c.line_item_id === item.id)
          .map(claim => {
            const claimUser = claimUsers.find(u => u.id === claim.user_id)
            return {
              ...claim,
              user: claimUser || { id: claim.user_id, full_name: 'Unknown', avatar_url: null, avatar_data: null }
            }
          })

        const totalClaimed = itemClaims.reduce((sum, c) => sum + Number(c.quantity_claimed), 0)
        const available = Number(item.quantity) - totalClaimed

        return {
          ...item,
          claims: itemClaims as any,
          availableQuantity: available
        }
      })

      setLineItems(itemsWithClaims)

      // 10. Pre-populate user's existing claims for editing
      const userClaims = (claims || []).filter(c => c.user_id === user.id)
      const existingSelections: Record<string, ClaimSelection> = {}

      userClaims.forEach(claim => {
        const lineItem = itemsWithClaims.find(item => item.id === claim.line_item_id)
        if (lineItem) {
          existingSelections[claim.line_item_id] = {
            lineItemId: claim.line_item_id,
            quantity: Number(claim.quantity_claimed),
            amount: Number(claim.amount_owed)
          }
        }
      })

      setSelections(existingSelections)

    } catch (err: any) {
      console.error('Error loading claim data:', err)
      setError(err.message || 'Failed to load claim information')
    } finally {
      setLoading(false)
    }
  }

  const handleQuantityChange = (lineItemId: string, quantityStr: string, lineItem: LineItemWithClaims) => {
    // Parse as decimal, allow empty string
    const quantity = quantityStr === '' ? 0 : parseFloat(quantityStr)

    if (isNaN(quantity) || quantity < 0) {
      // Invalid input, ignore
      return
    }

    // Don't allow claiming more than available
    const myExistingClaim = lineItem.claims.find(c => c.user_id === user?.id)
    const myPreviousClaim = myExistingClaim ? Number(myExistingClaim.quantity_claimed) : 0
    const maxAvailable = lineItem.availableQuantity + myPreviousClaim

    if (quantity > maxAvailable) {
      return
    }

    if (quantity === 0) {
      // Remove selection
      const newSelections = { ...selections }
      delete newSelections[lineItemId]
      setSelections(newSelections)
    } else {
      // Calculate amount for this quantity (proportional)
      const unitCost = Number(lineItem.total_amount) / Number(lineItem.quantity)
      const amount = unitCost * quantity

      setSelections({
        ...selections,
        [lineItemId]: {
          lineItemId,
          quantity,
          amount
        }
      })
    }
  }

  const calculateTotal = () => {
    return Object.values(selections).reduce((sum, sel) => sum + sel.amount, 0)
  }

  // Auto-save selections to database (debounced)
  const autoSaveClaims = async () => {
    if (!user || !expense) return

    const selectionsList = Object.values(selections)

    try {
      setSaving(true)

      // 1. Delete user's existing claims first
      const { error: deleteError } = await supabase
        .from('expense_item_claims')
        .delete()
        .eq('expense_id', expense.id)
        .eq('user_id', user.id)

      if (deleteError) throw deleteError

      // 2. Insert new claims (if any)
      if (selectionsList.length > 0) {
        const claimsToInsert = selectionsList.map(sel => ({
          line_item_id: sel.lineItemId,
          user_id: user.id,
          expense_id: expense.id,
          quantity_claimed: sel.quantity,
          amount_owed: sel.amount,
          confirmed: true
        }))

        const { error: claimsError } = await supabase
          .from('expense_item_claims')
          .insert(claimsToInsert)

        if (claimsError) throw claimsError
      }

      // 3. Update expense status based on full allocation
      const { data: allClaims } = await supabase
        .from('expense_item_claims')
        .select('quantity_claimed, line_item_id')
        .eq('expense_id', expense.id)

      const claimsByItem = (allClaims || []).reduce((acc, claim) => {
        if (!acc[claim.line_item_id]) acc[claim.line_item_id] = 0
        acc[claim.line_item_id] += Number(claim.quantity_claimed)
        return acc
      }, {} as Record<string, number>)

      const fullyAllocated = lineItems.every(item => {
        const claimed = claimsByItem[item.id] || 0
        return claimed >= Number(item.quantity)
      })

      const newStatus: Database['public']['Enums']['expense_status'] =
        fullyAllocated ? 'allocated' : 'pending_allocation'

      await supabase
        .from('expenses')
        .update({ status: newStatus })
        .eq('id', expense.id)

      console.log('✅ Auto-saved claims')
    } catch (err: any) {
      console.error('❌ Error auto-saving claims:', err)
    } finally {
      setSaving(false)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    )
  }

  // Error state
  if (error || !expense || !allocationLink) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-6 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Unable to Load Items</h2>
          <p className="text-sm text-gray-600 mb-4">{error || 'Something went wrong'}</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Go to Dashboard
          </Button>
        </div>
      </div>
    )
  }

  const total = calculateTotal()
  return (
    <div className="min-h-screen bg-gray-50 pb-48">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold text-gray-900">Claim Your Items</h1>
            <Badge variant="info">Expires in {Math.ceil((new Date(allocationLink.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))} days</Badge>
          </div>
          <p className="text-sm text-gray-600 mt-1">
            {expense.vendor_name} • Paid by {paidByUser?.full_name}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Instructions */}
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-4">
          <p className="text-sm font-medium text-sky-900">
            📋 How it works
          </p>
          <p className="text-sm text-sky-700 mt-1">
            Select the quantity of each item you ordered. Your share will be calculated automatically based on what you claim.
          </p>
        </div>

        {/* Line Items */}
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900">Items ({lineItems.length})</h2>

          {lineItems.map((item) => {
            const selected = selections[item.id]?.quantity || 0
            const available = item.availableQuantity

            return (
              <div
                key={item.id}
                className={`bg-white rounded-lg border-2 transition-colors ${
                  selected > 0 ? 'border-sky-500 shadow-sm' : 'border-gray-200'
                }`}
              >
                <div className="p-4">
                  {/* Item Header */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-medium text-gray-900">
                        {item.name_english || item.name_original}
                      </p>
                      {item.name_english && item.name_english !== item.name_original && (
                        <p className="text-sm text-gray-500 mt-0.5">
                          {item.name_original}
                        </p>
                      )}
                      <p className="text-sm text-gray-600 mt-1">
                        {formatCurrency(Number(item.total_amount) / Number(item.quantity), expense.currency as Currency)} per item
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-lg font-semibold text-gray-900">
                        {formatCurrency(Number(item.total_amount), expense.currency as Currency)}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Total: {Number(item.quantity).toFixed(1)}
                      </p>
                    </div>
                  </div>

                  {/* Who has claimed (confirmed + current user's live selection) */}
                  {(() => {
                    // Filter out current user's saved claims (we'll show their live selection instead)
                    const otherUsersClaims = item.claims.filter(c => c.user_id !== user?.id)
                    const hasCurrentUserSelection = selected > 0

                    if (otherUsersClaims.length === 0 && !hasCurrentUserSelection) {
                      return null
                    }

                    return (
                      <div className="mb-3">
                        <p className="text-xs font-medium text-gray-600 mb-2">✓ Confirmed:</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Other users' claims */}
                          {otherUsersClaims.map((claim) => (
                            <div
                              key={claim.id}
                              className="group relative"
                              title={`${claim.user.full_name}: ${Number(claim.quantity_claimed).toFixed(2)}`}
                            >
                              <div className="relative">
                                <div
                                  className="w-10 h-10 rounded-full flex flex-col items-center justify-center border-2 border-green-500"
                                  style={{
                                    backgroundColor: (claim.user.avatar_data as any)?.bgColor || '#0ea5e9',
                                  }}
                                >
                                  {(claim.user.avatar_data as any)?.accessory && (
                                    <span className="text-[10px] -mb-0.5">
                                      {(claim.user.avatar_data as any)?.accessory}
                                    </span>
                                  )}
                                  <span className="text-base">
                                    {(claim.user.avatar_data as any)?.emoji || '😊'}
                                  </span>
                                </div>
                                {/* Quantity badge */}
                                <div className="absolute -bottom-1 -right-1 bg-green-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center border-2 border-white">
                                  {Number(claim.quantity_claimed).toFixed(1)}
                                </div>
                              </div>
                              {/* Tooltip on hover */}
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                {claim.user.full_name}
                              </div>
                            </div>
                          ))}

                          {/* Current user's live selection */}
                          {hasCurrentUserSelection && currentUserProfile && (
                            <div
                              className="group relative"
                              title={`${currentUserProfile.full_name}: ${selected.toFixed(2)}`}
                            >
                              <div className="relative">
                                <div
                                  className="w-10 h-10 rounded-full flex flex-col items-center justify-center border-2 border-sky-500"
                                  style={{
                                    backgroundColor: (currentUserProfile.avatar_data as any)?.bgColor || '#0ea5e9',
                                  }}
                                >
                                  {(currentUserProfile.avatar_data as any)?.accessory && (
                                    <span className="text-[10px] -mb-0.5">
                                      {(currentUserProfile.avatar_data as any)?.accessory}
                                    </span>
                                  )}
                                  <span className="text-base">
                                    {(currentUserProfile.avatar_data as any)?.emoji || '😊'}
                                  </span>
                                </div>
                                {/* Quantity badge - sky color to indicate "you" */}
                                <div className="absolute -bottom-1 -right-1 bg-sky-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center border-2 border-white">
                                  {selected.toFixed(1)}
                                </div>
                              </div>
                              {/* Tooltip on hover */}
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                                You
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Quantity Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-700">Your quantity</p>
                        <p className="text-xs text-gray-500">Can use decimals (e.g., 0.5 for sharing)</p>
                      </div>
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max={available}
                        value={selected || ''}
                        onChange={(e) => handleQuantityChange(item.id, e.target.value, item)}
                        placeholder="0"
                        className="w-20 px-3 py-2 text-center text-lg font-semibold border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-transparent"
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-500">
                        Available: <span className="font-medium text-gray-700">{available.toFixed(2)}</span>
                      </span>
                      {selected > 0 && (
                        <span className="text-sky-600 font-medium">
                          You: {selected.toFixed(2)} / {Number(item.quantity).toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>

                  {selected > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-200">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Your share:</span>
                        <span className="font-semibold text-sky-700">
                          {formatCurrency(selections[item.id].amount, expense.currency as Currency)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-lg font-semibold text-gray-900">Your Total</span>
            <span className="text-2xl font-bold text-sky-700">
              {formatCurrency(total, expense.currency as Currency)}
            </span>
          </div>

          {/* Auto-save indicator */}
          <div className="mb-3">
            {saving ? (
              <p className="text-sm text-amber-600 flex items-center gap-2 justify-center">
                <span className="animate-spin">⏳</span>
                Saving...
              </p>
            ) : (
              <p className="text-sm text-green-600 flex items-center gap-2 justify-center">
                <span>✓</span>
                Changes saved automatically
              </p>
            )}
          </div>

          <Button
            variant="outline"
            onClick={() => navigate(`/${allocationLink.trip_id}?tab=expenses`)}
            className="w-full"
          >
            ← Back to Expenses
          </Button>
        </div>
      </div>
    </div>
  )
}
