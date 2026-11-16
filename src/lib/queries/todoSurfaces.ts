import { computeTodos, hasOverdue, organiserOnlyTodos, personalTodos } from '../todos/computeTodos'
import type { Todo, TripSnapshot } from '../todos/types'

/**
 * Pure cores behind the surfaces that show "how many to-dos": the trip header
 * pill (`useTodoCount`), the dashboard trip-card badge, and Today's "Your
 * to-dos" list. Everything is derived from `computeTodos`; nothing here filters
 * or slices the engine's list for the COUNT. Keeping it pure lets a unit test
 * pin the invariant that every surface agrees (todoSurfaces.test.ts).
 */

export interface TodoSurfaceCore {
  todos: Todo[]
  /** The one number every surface shows. `undefined` while loading (no snapshot / no user): never 0. */
  count: number | undefined
  hasOverdue: boolean
}

/** What `useTodos` / `useTodoCount` return for a signed-in user on one trip. */
export function todoSurfaceCore(snapshot: TripSnapshot | null, userId: string | null | undefined, now?: Date): TodoSurfaceCore {
  if (!snapshot || !userId) return { todos: [], count: undefined, hasOverdue: false }
  const todos = computeTodos(snapshot, userId, now)
  return { todos, count: todos.length, hasOverdue: hasOverdue(todos) }
}

/** The dashboard trip-card badge: the same count as the header pill. */
export function tripCardBadgeCount(snapshot: TripSnapshot | null, userId: string | null | undefined, now?: Date): number | undefined {
  return todoSurfaceCore(snapshot, userId, now).count
}

export const TODAY_COLLAPSED_ROWS = 5

export interface TodayListModel {
  personal: Todo[]
  /** Personal rows visible right now (first 5 until expanded). */
  shownPersonal: Todo[]
  organiser: Todo[]
  /** Rows reachable on Today (all personal + all organiser): always equals the count. */
  total: number
  /** "See all (n)" when personal rows are hidden, else null. */
  seeAllCount: number | null
}

/** How Today's "Your to-dos" card splits the engine's list. Collapsing only hides rows behind "See all"; nothing is dropped. */
export function todayListModel(todos: Todo[], expanded: boolean): TodayListModel {
  const personal = personalTodos(todos)
  const organiser = organiserOnlyTodos(todos)
  return {
    personal,
    shownPersonal: expanded ? personal : personal.slice(0, TODAY_COLLAPSED_ROWS),
    organiser,
    total: personal.length + organiser.length,
    seeAllCount: personal.length > TODAY_COLLAPSED_ROWS ? personal.length : null,
  }
}
