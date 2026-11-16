import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Card, Skeleton } from '../../../components/ui'
import { useTodos } from '../../../lib/queries/useTodos'
import { answerTodoList, canAnswerAll } from '../../../lib/todos/computeTodos'
import { todayListModel, TODAY_COLLAPSED_ROWS } from '../../../lib/queries/todoSurfaces'
import {
  DEEP_LINKS,
  ORGANISER_GROUP_HEADING,
  TODO_EMPTY_STATE,
  answerActionLabel,
  answerAllLabel,
  todoCountLabel,
} from '../../../lib/todos/copy'
import type { Todo } from '../../../lib/todos/types'

/** Anchor for `?open=todos` (the shell scrolls Today to this element). */
export const YOUR_TODOS_ANCHOR = 'your-todos'

function TodoRow({ todo, onOpen }: { todo: Todo; onOpen: (todo: Todo) => void }) {
  const label = todo.kind === 'answer' && todo.shape ? answerActionLabel(todo.shape) : todo.actionLabel
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{todo.title}</p>
        {(todo.subtitle || todo.overdue) && (
          <p className="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
            {todo.overdue && (
              <Badge variant="error" size="sm">
                Overdue
              </Badge>
            )}
            {todo.subtitle && <span>{todo.subtitle}</span>}
          </p>
        )}
      </div>
      <Button size="sm" variant="secondary" onClick={() => onOpen(todo)} className="shrink-0">
        {label}
      </Button>
    </li>
  )
}

/**
 * "Your to-dos" (proposal 3.3 / 3.5): the one list every surface agrees on.
 * Rows come straight from useTodos; tapping follows the engine's `?open=` link.
 * The empty state only appears when the engine returns nothing at all.
 */
export function YourTodosCard({ tripId }: { tripId: string }) {
  const navigate = useNavigate()
  const { todos, isLoading, isError } = useTodos(tripId)
  const [expanded, setExpanded] = useState(false)

  if (isLoading) return <Skeleton variant="card" height={120} />
  if (isError) {
    return (
      <section id={YOUR_TODOS_ANCHOR} aria-label="Your to-dos" className="scroll-mt-20">
        <Card>
          <Card.Content>
            <p className="text-sm text-[var(--text-secondary)]">Couldn't load your to-dos. Check your connection and try again.</p>
          </Card.Content>
        </Card>
      </section>
    )
  }

  const open = (todo: Todo) => navigate({ search: todo.link })
  const { personal, shownPersonal: shown, organiser } = todayListModel(todos, expanded)
  const answers = answerTodoList(todos)

  return (
    <section id={YOUR_TODOS_ANCHOR} aria-label="Your to-dos" className="scroll-mt-20">
      <Card>
        <Card.Content className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Your to-dos{todos.length > 0 ? ` · ${todoCountLabel(todos.length)}` : ''}
            </h2>
            {canAnswerAll(todos) && (
              <Button size="sm" variant="ghost" onClick={() => navigate({ search: DEEP_LINKS.answerAll() })}>
                {answerAllLabel(answers.length)}
              </Button>
            )}
          </div>

          {todos.length === 0 && (
            <div className="py-3">
              <p className="text-sm font-semibold text-[var(--text-primary)]">{TODO_EMPTY_STATE.headline}</p>
              <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{TODO_EMPTY_STATE.body}</p>
            </div>
          )}

          {shown.length > 0 && (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {shown.map((todo) => (
                <TodoRow key={todo.id} todo={todo} onOpen={open} />
              ))}
            </ul>
          )}

          {personal.length > TODAY_COLLAPSED_ROWS && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show fewer' : `See all (${personal.length})`}
            </Button>
          )}

          {organiser.length > 0 && (
            <div className="pt-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                {ORGANISER_GROUP_HEADING}
              </h3>
              <ul className="divide-y divide-[var(--border-subtle)]">
                {organiser.map((todo) => (
                  <TodoRow key={todo.id} todo={todo} onOpen={open} />
                ))}
              </ul>
            </div>
          )}
        </Card.Content>
      </Card>
    </section>
  )
}
