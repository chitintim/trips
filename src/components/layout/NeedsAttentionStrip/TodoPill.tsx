import { ButtonHTMLAttributes } from 'react'
import { todoCountLabel } from '../../../lib/todos/copy'

export interface TodoPillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The one to-do count every surface shows (`useTodoCount`). The pill renders nothing at 0. */
  count: number
  /** Red when any to-do is overdue. */
  hasOverdue?: boolean
}

/**
 * Header pill: "3 to-dos", red if any are overdue, hidden at 0. Replaces the
 * NeedsAttentionStrip chips (UX redesign 3.5). Tapping it opens Your to-dos
 * (`?open=todos`); the caller owns the click so the shell decides where.
 */
export function TodoPill({ count, hasOverdue = false, className = '', type = 'button', ...props }: TodoPillProps) {
  if (count <= 0) return null
  const tone = hasOverdue
    ? 'bg-danger-50 text-danger-700 border-danger-300 hover:bg-danger-100 dark:bg-danger-900/40 dark:text-danger-300 dark:border-danger-800'
    : 'bg-accent-50 text-accent-700 border-accent-200 hover:bg-accent-100 dark:bg-accent-950 dark:text-accent-300 dark:border-accent-800'
  return (
    <button
      type={type}
      data-testid="todo-pill"
      aria-label={hasOverdue ? `${todoCountLabel(count)}, some overdue. Open your to-dos` : `${todoCountLabel(count)}. Open your to-dos`}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-full border px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors ${tone} ${className}`}
      {...props}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${hasOverdue ? 'bg-danger-500' : 'bg-accent-500'}`} />
      {todoCountLabel(count)}
    </button>
  )
}

TodoPill.displayName = 'TodoPill'
