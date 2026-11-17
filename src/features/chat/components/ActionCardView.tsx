import { Button } from '../../../components/ui'
import type { CardPhase } from '../lib/confirmFlow'
import type { CardView } from '../actions/types'

export interface ActionCardViewProps {
  view: CardView
  tier: 'tap' | 'review'
  phase: CardPhase
  /** Stale reason, failure or blocked wording, whichever applies to the phase. */
  message: string | null
  doneText: string | null
  /** The params could not be read: no Confirm. */
  invalid: boolean
  showUndo: boolean
  undoing: boolean
  undone: boolean
  onConfirm: () => void
  onDismiss: () => void
  onUndo: () => void
  /** "Ask again" on a stale card: puts the request back in the chat box. */
  onAskAgain?: () => void
}

const TERMINAL_TEXT: Partial<Record<CardPhase, string>> = {
  dismissed: 'Not now. Nothing was changed.',
  expired: 'This suggestion has expired. Ask me again if you still want it.',
  edited: 'You changed this on its own screen instead.',
  working_elsewhere: 'This is already being added (maybe on another device).',
}

/**
 * One suggested action, drawn only from structured data (`view` is built from the action's params and the app's live data,
 * never from anything the model wrote). Tap tier: a compact row. Review tier: every fact, then Confirm / Not now.
 */
export function ActionCardView(p: ActionCardViewProps) {
  const live = p.phase === 'proposed' || p.phase === 'running' || p.phase === 'stale' || p.phase === 'blocked'
  const canConfirm = (p.phase === 'proposed' || p.phase === 'blocked') && !p.invalid
  return (
    <div
      className={`rounded-[var(--radius-lg)] border bg-[var(--surface-raised)] p-3 ${p.phase === 'failed' ? 'border-danger-300' : 'border-[var(--border-subtle)]'}`}
      data-testid="action-card"
      data-phase={p.phase}
      data-tier={p.tier}
    >
      {p.tier === 'tap' && live ? (
        <p className="text-sm text-[var(--text-primary)]">
          <span aria-hidden="true">{p.view.icon} </span>
          {p.view.line}
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <span aria-hidden="true">{p.view.icon}</span>
            {p.view.title}
          </p>
          <dl className="mt-2 space-y-1.5 text-sm">
            {p.view.rows.map((r) => (
              <div key={r.label} className="flex flex-wrap gap-x-2">
                <dt className="w-24 shrink-0 text-[var(--text-muted)]">{r.label}</dt>
                <dd className="min-w-0 flex-1 break-words text-[var(--text-primary)]">
                  {r.quoted ? <q>{r.value}</q> : r.value}
                  {r.from && <span className="ml-1 text-xs text-[var(--text-muted)]">({r.from})</span>}
                  {r.lines && (
                    <ul className="mt-0.5 space-y-0.5">
                      {r.lines.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {(p.view.warnings ?? []).map((w) => (
            <p key={w} role="note" data-testid="card-warning" className="mt-2 rounded-[var(--radius-md)] bg-warn-50 px-2 py-1.5 text-sm font-medium text-warn-800 dark:bg-warn-950 dark:text-warn-200">
              {w}
            </p>
          ))}
          {p.view.notes.map((n) => (
            <p key={n} className="mt-2 text-xs text-[var(--text-muted)]">
              {n}
            </p>
          ))}
        </>
      )}

      {p.phase === 'stale' && p.message && (
        <p role="status" className="mt-2 rounded-[var(--radius-md)] bg-warn-50 px-2 py-1.5 text-sm text-warn-800 dark:bg-warn-950 dark:text-warn-200">
          This changed: {p.message}
        </p>
      )}
      {p.phase === 'blocked' && p.message && (
        <p role="alert" className="mt-2 text-sm text-danger-700 dark:text-danger-400">
          {p.message}
        </p>
      )}
      {p.phase === 'failed' && (
        <p role="alert" className="mt-2 text-sm text-danger-700 dark:text-danger-400">
          {p.message ?? "That didn't go through."}
        </p>
      )}
      {p.invalid && live && <p className="mt-2 text-sm text-[var(--text-muted)]">I can't show this suggestion properly, so it can't be run from here.</p>}
      {TERMINAL_TEXT[p.phase] && <p className="mt-2 text-sm text-[var(--text-muted)]">{TERMINAL_TEXT[p.phase]}</p>}
      {p.phase === 'stuck' && (
        <div className="mt-2">
          <p role="alert" className="text-sm text-warn-800 dark:text-warn-200">
            {p.message}
          </p>
          <Button size="md" variant="secondary" onClick={p.onDismiss}>
            Dismiss
          </Button>
        </div>
      )}

      {p.phase === 'done' && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-success-700 dark:text-success-400">{p.undone ? 'Undone' : `Done ✓${p.doneText ? ` · ${p.doneText}` : ''}`}</span>
          {p.showUndo && !p.undone && (
            <Button size="md" variant="ghost" isLoading={p.undoing} onClick={p.onUndo}>
              Undo
            </Button>
          )}
        </div>
      )}

      {(p.phase === 'proposed' || p.phase === 'running' || p.phase === 'stale' || p.phase === 'blocked') && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="md" variant="primary" disabled={!canConfirm} isLoading={p.phase === 'running'} onClick={p.onConfirm}>
            {p.tier === 'tap' ? 'Confirm' : p.view.confirmLabel}
          </Button>
          <Button size="md" variant="ghost" disabled={p.phase === 'running'} onClick={p.onDismiss}>
            Not now
          </Button>
          {p.phase === 'stale' && p.onAskAgain && (
            <Button size="md" variant="secondary" onClick={p.onAskAgain}>
              Ask again
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
