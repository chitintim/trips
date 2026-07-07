import { UserAvatar } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface LiableAvatarStackProps {
  /** Resolved participants for the liable user_ids, in display order (already excludes the payer -- see ExpenseCard). */
  participants: Array<ParticipantWithUser | undefined>
  max?: number
  size?: 'xs' | 'sm'
  className?: string
}

/**
 * Compact overlapping avatar stack for "who's liable for this line" (plan
 * point 1: reuse SelectionAvatars "or Avatar row" -- this is the lighter
 * "Avatar row" option, deliberately WITHOUT SelectionAvatars' click-to-open
 * popover/portal machinery, since a feed can render dozens of rows and each
 * popover instance wires up its own document listeners). Purely a visual
 * stack + overflow count; the meta sentence next to it carries the actual
 * semantics ("split with you +2" etc).
 */
export function LiableAvatarStack({ participants, max = 4, size = 'xs', className = '' }: LiableAvatarStackProps) {
  if (participants.length === 0) return null

  const visible = participants.slice(0, max)
  const overflow = Math.max(0, participants.length - max)
  const dim = size === 'xs' ? 'w-5 h-5 text-[9px]' : 'w-6 h-6 text-[10px]'

  return (
    <div className={`flex items-center -space-x-1.5 shrink-0 ${className}`.trim()}>
      {visible.map((p, i) => (
        <UserAvatar
          key={p?.user_id ?? i}
          avatarData={p?.user}
          size={size}
          alt={p?.user?.full_name ?? p?.user?.email ?? 'Participant'}
          title={p?.user?.full_name ?? p?.user?.email ?? undefined}
          className="ring-2 ring-[var(--surface-raised)]"
        />
      ))}
      {overflow > 0 && (
        <div
          className={`${dim} rounded-full flex items-center justify-center bg-[var(--surface-sunken)] text-[var(--text-secondary)] font-medium ring-2 ring-[var(--surface-raised)]`}
          title={`+${overflow} more`}
        >
          +{overflow}
        </div>
      )}
    </div>
  )
}
