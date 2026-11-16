import { useMemo } from 'react'
import { Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTodos, useWaitingOn } from '../../../lib/queries/useTodos'
import { buildOrganiserSummary } from '../lib/organiserSummaryModel'

/**
 * Organiser-only compact card (proposal 3.6): "As organizer: waiting on 6
 * people · 2 to decide · 1 to book" + the top things people still owe, with a
 * link into the Console. The organiser's own to-dos sit in Your to-dos.
 */
export function OrganiserSummaryCard({ tripId, onOpenConsole }: { tripId: string; onOpenConsole: () => void }) {
  const { user } = useAuth()
  const { todos } = useTodos(tripId)
  const { waitingOn, isLoading } = useWaitingOn(tripId)

  const summary = useMemo(() => (waitingOn ? buildOrganiserSummary(waitingOn, user?.id, todos) : null), [waitingOn, todos, user?.id])

  if (isLoading || !summary) return null

  return (
    <Card variant="flat">
      <Card.Content className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            {summary.headline}
          </p>
          <Button size="sm" variant="secondary" onClick={onOpenConsole} className="shrink-0">
            Open console
          </Button>
        </div>
        {summary.lines.length > 0 && (
          <ul className="space-y-0.5">
            {summary.lines.map((line) => (
              <li key={line} className="truncate text-sm text-[var(--text-secondary)]">
                {line}
              </li>
            ))}
          </ul>
        )}
      </Card.Content>
    </Card>
  )
}
