import { useEffect, useState } from 'react'
import { Modal, Button, Badge, UserAvatar, ConfirmationStatusBadge, useToast } from '../../../components/ui'
import { useSetParticipantActive } from '../../../lib/queries/useConfirmations'
import { useExpenses } from '../../../lib/queries/useExpenses'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { computeBalances } from '../../expenses/lib/balances'
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

  const balance = expensesData
    ? computeBalances(
        expensesData.expenses,
        expensesData.settlements,
        participants.map((p) => p.user_id),
        baseCurrency
      ).balances.find((b) => b.userId === participant.user_id)
    : undefined

  const handleRemove = async () => {
    try {
      await setActive.mutateAsync({ userId: participant.user_id, active: false })
      showToast({ type: 'success', message: `${name} removed from the trip`, description: 'Their expense history and balance are unchanged -- you can re-add them any time.' })
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

        {balance && !balance.isBalanced && (
          <div className="bg-[var(--surface-sunken)] rounded-[var(--radius-md)] p-3 text-sm text-[var(--text-secondary)]">
            {balance.netBalanceMinor > 0
              ? `${name} is owed ${formatMoneyMinor(balance.netBalanceMinor, baseCurrency)} — `
              : `${name} owes ${formatMoneyMinor(-balance.netBalanceMinor, baseCurrency)} — `}
            you can still settle up with them after removing them from the trip.
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
              <Button variant="danger" onClick={() => setConfirming(true)} disabled={isSoleOrganizer}>
                Remove from trip
              </Button>
            </div>
          </>
        ) : (
          <div className="space-y-4">
            <div className="bg-danger-50 border border-danger-200 rounded-[var(--radius-md)] p-3 text-sm text-danger-800">
              Removes {name} from the trip roster. Their expense history and any outstanding balance stay intact — you
              can still settle up with them, and you can re-add them later.
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
