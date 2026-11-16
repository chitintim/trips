import { useMemo } from 'react'
import { Button, Card } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTodos, useWaitingOn } from '../../../lib/queries/useTodos'
import { WAITING_ON_EMPTY, organiserSummary } from '../../../lib/todos/copy'
import { doneCountLabel } from '../../actions/lib/todoLabels'

/**
 * Organiser-only compact card (proposal 3.6): "As organizer: waiting on 6
 * people · 2 to decide · 1 to book" + the top things people still owe, with a
 * link into the Console. The organiser's own to-dos sit in Your to-dos.
 */
export function OrganiserSummaryCard({ tripId, onOpenConsole }: { tripId: string; onOpenConsole: () => void }) {
  const { user } = useAuth()
  const { todos } = useTodos(tripId)
  const { waitingOn, isLoading } = useWaitingOn(tripId)

  const summary = useMemo(() => {
    if (!waitingOn) return null
    const people = waitingOn.byPerson.filter(
      (p) => p.userId !== user?.id && p.todos.some((t) => t.group === 'personal')
    ).length
    const items = waitingOn.byItem.filter((i) => i.group === 'personal' && i.userIds.some((id) => id !== user?.id))
    return {
      people,
      items: items.slice(0, 3),
      toDecide: todos.filter((t) => t.kind === 'org_decide').length,
      toBook: todos.filter((t) => t.kind === 'org_book').length,
    }
  }, [waitingOn, todos, user?.id])

  if (isLoading || !summary) return null
  const nothing = summary.people === 0 && summary.toDecide === 0 && summary.toBook === 0

  return (
    <Card variant="flat">
      <Card.Content className="space-y-2 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            {nothing ? `As organizer: ${WAITING_ON_EMPTY}` : organiserSummary(summary.people, summary.toDecide, summary.toBook)}
          </p>
          <Button size="sm" variant="secondary" onClick={onOpenConsole} className="shrink-0">
            Open console
          </Button>
        </div>
        {summary.items.length > 0 && (
          <ul className="space-y-0.5">
            {summary.items.map((item) => (
              <li key={item.id} className="truncate text-sm text-[var(--text-secondary)]">
                {item.title}
                {item.done != null && item.total != null
                  ? ` · ${item.kind === 'answer' ? `${item.done} of ${item.total} answered` : doneCountLabel(item.done, item.total)}`
                  : ''}
              </li>
            ))}
          </ul>
        )}
      </Card.Content>
    </Card>
  )
}
