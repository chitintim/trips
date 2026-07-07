import { Chip, UserAvatar } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface ParticipantChipRowProps {
  participants: ParticipantWithUser[]
  selectedUserIds: string[]
  onToggle: (userId: string) => void
  disabled?: boolean
}

/**
 * "WHO WAS THERE?" participant chip row (plan §10 details step): defaults
 * to all participants selected, writes to expenses.participant_ids. Also
 * reused as the base multi-select for the split step.
 */
export function ParticipantChipRow({ participants, selectedUserIds, onToggle, disabled }: ParticipantChipRowProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {participants.map((p) => {
        const selected = selectedUserIds.includes(p.user_id)
        return (
          <Chip
            key={p.user_id}
            selected={selected}
            onClick={() => onToggle(p.user_id)}
            disabled={disabled}
            icon={<UserAvatar avatarData={p.user} size="xs" alt={p.user.full_name ?? p.user.email} />}
          >
            {p.user.full_name || p.user.email}
          </Chip>
        )
      })}
    </div>
  )
}
