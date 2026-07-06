import { Modal } from '../../ui'

export interface QuickAction {
  key: string
  icon: React.ReactNode
  label: string
  description?: string
  onClick: () => void
}

export interface QuickActionsSheetProps {
  isOpen: boolean
  onClose: () => void
  actions: QuickAction[]
}

/**
 * The shell FAB's landing sheet (UPGRADE_MASTER_PLAN §5/§6): a small menu of
 * quick actions rather than jumping straight into one flow. Each action
 * closes this sheet and opens its own sheet/navigation — this component
 * owns no feature logic itself, just the menu chrome, so it stays reusable
 * across trip stages/roles (the caller decides which actions to pass in,
 * e.g. omitting organizer-only actions for participants).
 */
export function QuickActionsSheet({ isOpen, onClose, actions }: QuickActionsSheetProps) {
  const handleAction = (action: QuickAction) => {
    onClose()
    action.onClick()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Quick actions" size="sm">
      <div className="grid grid-cols-2 gap-3">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            onClick={() => handleAction(action)}
            className="flex flex-col items-start gap-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-4 text-left hover:border-accent-300 hover:shadow-md active:scale-[0.98] transition-all duration-150"
          >
            <span className="text-2xl leading-none" aria-hidden="true">
              {action.icon}
            </span>
            <span className="text-sm font-medium text-[var(--text-primary)]">{action.label}</span>
            {action.description && (
              <span className="text-xs text-[var(--text-muted)]">{action.description}</span>
            )}
          </button>
        ))}
      </div>
    </Modal>
  )
}

QuickActionsSheet.displayName = 'QuickActionsSheet'
