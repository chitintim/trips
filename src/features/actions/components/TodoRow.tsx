import { Badge, Button, LinkifiedText, UserAvatar } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { claimLabel, claimedByLabel, doneCountLabel, leftLabel, NO_LONGER_NEEDED, TICKS_WHEN_ANSWERED, UNCLAIM_LABEL, WHO_ANYONE, WHO_EVERYONE } from '../lib/todoLabels'
import { canClaim, canEditOrDelete, canTick, canUnclaim, dueChip, isTickOnBehalf, rowDomId } from '../lib/todoModel'
import type { TodoView, Viewer } from '../lib/todoModel'

export interface TodoRowProps {
  view: TodoView
  participants: ParticipantWithUser[]
  viewer: Viewer
  /** This row has a write in flight: its controls are disabled (other rows stay live). */
  busy?: boolean
  confirmingDelete: boolean
  onTick: (done: boolean) => void
  onClaim: () => void
  onUnclaim: () => void
  onEdit: () => void
  onDelete: () => void
  onCancelDelete: () => void
}

/**
 * The one to-do row for BOTH tables: trip_actions and trip_checklists render
 * identically (title, Who line, due chip, one tick control, claim / give back,
 * Edit, delete). The only source-specific wording is "I'll bring it" vs "I'll do it".
 */
export function TodoRow({ view, participants, viewer, busy = false, confirmingDelete, onTick, onClaim, onUnclaim, onEdit, onDelete, onCancelDelete }: TodoRowProps) {
  const byId = new Map(participants.map((p) => [p.user_id, p]))
  const nameOf = (id: string | null | undefined) => {
    const u = id ? byId.get(id)?.user : null
    return ((u?.full_name || u?.email || '') as string).split(' ')[0] || null
  }
  const assignee = view.assigneeId ? byId.get(view.assigneeId) : undefined
  const assigneeName = nameOf(view.assigneeId)
  const isMine = !!viewer.userId && view.assigneeId === viewer.userId
  const tickable = canTick(view, viewer)
  const onBehalf = isTickOnBehalf(view, viewer)
  const chip = dueChip(view, viewer.finished)
  const showEditDelete = canEditOrDelete(view, viewer)
  const myCheck = view.mode === 'everyone' ? view.doneForViewer : view.done
  const leftNames = view.leftIds.map((id) => nameOf(id) ?? 'Someone')

  const tickLabel =
    view.mode === 'everyone'
      ? `Mark yours ${myCheck ? 'not done' : 'done'} for "${view.title}"`
      : `Mark "${view.title}" ${view.done ? 'not done' : 'done'}${onBehalf && assigneeName ? ` for ${assigneeName}` : ''}`

  return (
    <li
      id={rowDomId(view)}
      className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2.5 transition-shadow"
    >
      {view.mode === 'anyone' && !view.assigneeId && !view.done ? (
        <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center text-base" title={WHO_ANYONE}>
          {view.isBring ? '🎒' : '🙋'}
        </span>
      ) : tickable ? (
        <DoneCircle checked={myCheck} disabled={busy} onToggle={onTick} label={tickLabel} subtle={onBehalf} />
      ) : (
        <StaticCircle checked={myCheck || view.done} />
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <LinkifiedText
            text={view.title}
            className={`min-w-0 break-words text-sm font-medium ${view.done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-primary)]'}`}
          />
          {chip && (
            <Badge variant={chip.tone === 'overdue' ? 'warning' : 'neutral'} size="sm">
              {chip.label}
            </Badge>
          )}
        </div>
        {view.notes && <LinkifiedText as="p" text={view.notes} className="min-w-0 break-words text-xs text-[var(--text-secondary)]" />}
        {view.sectionId && (
          <p className="text-xs italic text-[var(--text-muted)]">{view.noLongerNeeded ? NO_LONGER_NEEDED : TICKS_WHEN_ANSWERED}</p>
        )}

        {!view.noLongerNeeded && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">
            {view.mode === 'everyone' ? (
              <>
                <span className="font-medium">{WHO_EVERYONE}</span>
                <span>· {doneCountLabel(view.doneIds.length, view.total)}</span>
                {leftNames.length > 0 && !view.done && <span>· {leftLabel(leftNames)}</span>}
              </>
            ) : view.mode === 'anyone' && !view.assigneeId ? (
              <span>{WHO_ANYONE}</span>
            ) : (
              <span className="flex items-center gap-1.5">
                {assignee?.user && <UserAvatar avatarData={assignee.user} size="xs" className={view.done ? 'opacity-60 grayscale' : undefined} />}
                {view.mode === 'anyone' || view.isBring ? (
                  view.done ? (
                    <span>{isMine ? 'You did it' : `${assigneeName ?? 'Someone'} did it`}</span>
                  ) : (
                    <span>{claimedByLabel(assigneeName, isMine, view.isBring)}</span>
                  )
                ) : (
                  <span>
                    {isMine ? 'You' : (assigneeName ?? 'Someone')}
                    {view.done ? ' · done' : ''}
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        {confirmingDelete && (
          <div className="flex items-center gap-2 pt-1 text-xs">
            <span className="text-[var(--text-secondary)]">Delete this to-do?</span>
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} className="text-danger-600 hover:text-danger-700">
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelDelete}>
              Keep
            </Button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {canClaim(view, viewer) && (
          <Button size="sm" onClick={onClaim} disabled={busy}>
            {claimLabel(view.isBring)}
          </Button>
        )}
        {canUnclaim(view, viewer) && (
          <Button variant="ghost" size="sm" onClick={onUnclaim} disabled={busy}>
            {UNCLAIM_LABEL}
          </Button>
        )}
        {showEditDelete && (
          <>
            <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit "${view.title}"`}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete "${view.title}"`} className="text-danger-600 hover:text-danger-700">
              ✕
            </Button>
          </>
        )}
      </div>
    </li>
  )
}

const CHECK_PATH = (
  <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 6.5 4.7 9 10 3.5" />
  </svg>
)

/** Read-only state circle (someone else's to-do, or a finished trip's history). */
function StaticCircle({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
        checked ? 'border-success-500 bg-success-500 text-white' : 'border-[var(--border-subtle)] text-transparent'
      }`}
    >
      {CHECK_PATH}
    </span>
  )
}

/** Tappable done-toggle: a 24px circle inside a 44px hit area. `subtle` = an organizer ticking for someone else. */
function DoneCircle({ checked, disabled, subtle, onToggle, label }: { checked: boolean; disabled: boolean; subtle: boolean; onToggle: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onToggle(!checked)}
      className="group/done relative -my-2 -ml-2 -mr-1 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        className={`flex h-6 w-6 items-center justify-center rounded-full border-2 transition-all duration-150 ${
          checked
            ? 'border-success-500 bg-success-500 text-white'
            : `${subtle ? 'border-dashed ' : ''}border-[var(--border-default)] bg-[var(--surface-raised)] text-transparent group-hover/done:border-success-500`
        }`}
      >
        {CHECK_PATH}
      </span>
    </button>
  )
}
