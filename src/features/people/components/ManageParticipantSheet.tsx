import { useEffect, useState } from 'react'
import { Modal, Button, Badge, UserAvatar, ConfirmationStatusBadge, useToast } from '../../../components/ui'
import { useSetParticipantActive } from '../../../lib/queries/useConfirmations'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useSettlementCarryovers } from '../../../lib/queries/useSettlements'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { evaluateRemovalGuard } from '../lib/removalGuard'
import { formatMoneyMinor } from '../../expenses/lib/formatMoney'

interface ManageParticipantSheetProps {
  tripId: string
  /** The participant being managed. Rendered only while this is set (see PeopleTab -- conditional mount keeps the balance fetch below from firing unless the sheet is actually open). */
  participant: ParticipantWithUser
  onClose: () => void
  /** Full active roster -- used for the "last organizer" guardrail and to seed the balance computation. */
  participants: ParticipantWithUser[]
  /** Trip's base currency, for formatting the outstanding-balance note. */
  baseCurrency: string
  /** Whether this trip tracks RSVP confirmation status -- hides the status badge when it carries no meaning. */
  confirmationEnabled: boolean
  currentUserId?: string
}

/**
 * Organizer/admin "manage participant" sheet, opened from the People tab's
 * participant list (feature request: "add or remove people tagged to a
 * trip"). Deliberately small -- a name/role recap, an optional outstanding-
 * balance heads-up, and a single reversible "Remove from trip" action gated
 * behind an inline confirm step. No role-editing here (out of scope for this
 * pass); the only mutation is trip_participants.active, which
 * useParticipants/blockers already treat as the soft-delete flag.
 */
export function ManageParticipantSheet({
  tripId,
  participant,
  onClose,
  participants,
  baseCurrency,
  confirmationEnabled,
  currentUserId,
}: ManageParticipantSheetProps) {
  const { showToast } = useToast()
  const setActive = useSetParticipantActive(tripId)
  // Balance data is only needed to populate the inline heads-up note, so it's
  // fetched lazily here rather than in PeopleTab -- this sheet only mounts
  // while an organizer/admin has actually opened it (see PeopleTab.tsx).
  const { data: expensesData } = useExpenses(tripId)
  // Folded cross-trip carryovers count toward the outstanding-balance note
  // below -- same balance math (and same inputs) as every Money surface.
  const { data: carryovers = [] } = useSettlementCarryovers(tripId)

  const [confirming, setConfirming] = useState(false)

  // Fresh-state guarantee: reset the confirm step whenever a different
  // participant is opened, so a stale "confirming" state can never leak
  // from a previous person onto this one.
  useEffect(() => {
    setConfirming(false)
  }, [participant.user_id])

  const name = participant.user?.full_name || participant.user?.email || 'This person'
  const isSelf = participant.user_id === currentUserId

  const organizerCount = participants.filter((p) => p.role === 'organizer').length
  const isSoleOrganizer = participant.role === 'organizer' && organizerCount <= 1

  // Same rules as the server trigger guard_participant_removal (see
  // removalGuard.ts). While the expense data is still loading the guard
  // reports `loading` and removal stays blocked -- a missing balance must
  // never read as "no balance".
  const guard = evaluateRemovalGuard({
    userId: participant.user_id,
    expenses: expensesData?.expenses,
    settlements: expensesData?.settlements,
    carryovers,
    activeUserIds: participants.map((p) => p.user_id),
    baseCurrency,
  })
  const blockingBalance = guard.hasBalance
  const hasOpenSettlement = guard.hasOpenSettlement
  const balanceMinor = guard.netBalanceMinor ?? 0
  const blockRemoval = guard.blocked

  const handleRemove = async () => {
    if (blockRemoval) {
      showToast({
        type: 'error',
        message: guard.loading ? 'Still checking balances' : `${name} can't be removed yet`,
        description: guard.loading
          ? 'Try again in a moment.'
          : 'Settle up (and let any payment in progress finish) before removing them.',
      })
      return
    }
    try {
      await setActive.mutateAsync({ userId: participant.user_id, active: false })
      showToast({ type: 'success', message: `${name} removed from the trip.`, description: 'Their past expenses stay in the ledger; add them back any time.' })
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not remove participant', description: err instanceof Error ? err.message : undefined })
    }
  }

  return (
    <Modal isOpen onClose={onClose} size="sm" title="Manage participant">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <UserAvatar avatarData={participant.user} size="md" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--text-primary)] truncate">
              {name}
              {isSelf && <span className="text-[var(--text-muted)] font-normal"> (you)</span>}
            </p>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={participant.role === 'organizer' ? 'secondary' : 'neutral'} size="sm">
                {participant.role === 'organizer' ? 'Organizer' : 'Participant'}
              </Badge>
              {confirmationEnabled && <ConfirmationStatusBadge status={participant.confirmation_status || 'pending'} size="sm" />}
            </div>
          </div>
        </div>

        {guard.loading && (
          <div className="text-xs text-[var(--text-muted)]">Checking {name}&apos;s balance…</div>
        )}
        {blockingBalance && (
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 text-sm text-warn-800">
            {balanceMinor > 0
              ? `${name} is owed ${formatMoneyMinor(balanceMinor, baseCurrency)}`
              : `${name} owes ${formatMoneyMinor(-balanceMinor, baseCurrency)}`}
            {' — settle up before removing them, or the group balances will no longer add up.'}
          </div>
        )}
        {!blockingBalance && guard.hasUnconvertedExpenses && (
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 text-sm text-warn-800">
            {name} paid or shares expenses that have no exchange rate yet, so their balance can&apos;t be worked out.
            Add the rate to those expenses before removing them.
          </div>
        )}
        {!blockingBalance && hasOpenSettlement && (
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 text-sm text-warn-800">
            {name} has a payment still in progress (marked paid but not yet confirmed, or still suggested) — let it
            finish before removing them. If it is only an out-of-date suggestion, an organizer can unfreeze balances
            on the Settle up tab and freeze again to refresh the suggestions.
          </div>
        )}

        {!confirming ? (
          <>
            {isSoleOrganizer && (
              <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 text-sm text-warn-800">
                {name} is the only organizer on this trip. Make someone else an organizer before removing them, or the
                trip will have nobody able to manage it.
              </div>
            )}
            <div className="flex gap-3 justify-end pt-2 border-t border-[var(--border-subtle)]">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button variant="danger" onClick={() => setConfirming(true)} disabled={isSoleOrganizer || blockRemoval}>
                Remove from trip
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="bg-danger-50 border border-danger-200 rounded-[var(--radius-md)] p-3 text-sm text-danger-800">
              Removes {name} from the trip roster. Their past expenses stay in the ledger, and you can re-add them any
              time.
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={setActive.isPending}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleRemove} isLoading={setActive.isPending}>
                Yes, remove {name}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
