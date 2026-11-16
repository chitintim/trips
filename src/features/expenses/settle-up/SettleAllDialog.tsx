import { Button, Modal } from '../../../components/ui'
import { formatMoney } from '../lib/formatMoney'
import { SETTLE_ALL_WARNING, STATUS_PHRASE, settleAllConfirmLabel, type SettleAllList, type BatchOutcome } from './settleOnBehalf'

interface SettleAllDialogProps {
  isOpen: boolean
  onClose: () => void
  list: SettleAllList
  isWorking: boolean
  /** After a run: the rows that failed, with why. Successes drop out of `list` by themselves. */
  outcome: BatchOutcome | null
  onConfirm: () => void
}

/** "Mark everything as settled…": lists every unfinished payment before anything is recorded. */
export function SettleAllDialog({ isOpen, onClose, list, isWorking, outcome, onConfirm }: SettleAllDialogProps) {
  const failedById = new Map((outcome?.failed ?? []).map((f) => [f.id, f.message]))
  const total = list.totals.map((t) => formatMoney(t.amount, t.currency)).join(' + ')
  return (
    <Modal isOpen={isOpen} onClose={isWorking ? () => undefined : onClose} title="Mark everything as settled" size="md">
      <div className="space-y-3">
        {list.count === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">Nothing is left to settle.</p>
        ) : (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              {list.count} {list.count === 1 ? 'payment' : 'payments'}, {total} in total:
            </p>
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {list.rows.map((r) => (
                <li key={r.id} className="text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[var(--text-primary)]">
                      {r.fromName} → {r.toName}
                    </span>
                    <span className="tabular-nums font-medium">{formatMoney(r.amount, r.currency)}</span>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">{STATUS_PHRASE[r.status]}</p>
                  {failedById.has(r.id) && (
                    <p className="text-xs text-danger-700 dark:text-danger-300" role="alert">
                      Failed: {failedById.get(r.id)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-sm font-medium text-[var(--text-primary)]">{SETTLE_ALL_WARNING}</p>
          </>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={isWorking}>
            {list.count === 0 ? 'Close' : 'Cancel'}
          </Button>
          {list.count > 0 && (
            <Button variant="primary" onClick={onConfirm} isLoading={isWorking} disabled={isWorking}>
              {settleAllConfirmLabel(list.count)}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
