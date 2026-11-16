import type { Todo, WaitingOn, WaitingOnItem } from '../../../lib/todos/types'
import { WAITING_ON_EMPTY, organiserSummary } from '../../../lib/todos/copy'
import { doneCountLabel } from '../../actions/lib/todoLabels'

/** Lines shown under the headline. */
const MAX_LINES = 3

export interface OrganiserSummary {
  headline: string
  /** One line per thing people still owe, each saying WHO owes it. */
  lines: string[]
  /** True when there is nothing to show at all (no waiting people, no decisions, no blocked money). */
  nothing: boolean
}

const lowerFirst = (text: string) => (text ? text.charAt(0).toLowerCase() + text.slice(1) : text)

/** `blockedMoney`: people who owe money but cannot pay until the organiser freezes balances. */
export function blockedMoneyText(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'} can't settle until you freeze balances`
}

/**
 * One line of the summary: WHO owes it, then what ("Salim: pay Chris £105.11").
 * Bare "Pay Chris £105.11" reads as if the viewer must pay.
 */
export function summaryLine(item: WaitingOnItem, others: ReadonlyArray<string>, nameOf: (userId: string) => string): string {
  const progress =
    item.done != null && item.total != null ? ` · ${item.kind === 'answer' ? `${item.done} of ${item.total} answered` : doneCountLabel(item.done, item.total)}` : ''
  // Questions already name their own scope ("3 of 9 answered"); everything else needs a "who".
  if (item.kind === 'answer') return `${item.title}${progress}`
  const who = others.length <= 2 ? others.map(nameOf).join(' & ') : `${others.length} people`
  return `${who}: ${lowerFirst(item.title)}${progress}`
}

export function buildOrganiserSummary(
  waitingOn: WaitingOn,
  viewerId: string | undefined,
  myTodos: ReadonlyArray<Todo>
): OrganiserSummary {
  const names = new Map(waitingOn.byPerson.map((p) => [p.userId, p.name]))
  const nameOf = (id: string) => names.get(id) ?? 'Someone'
  const people = waitingOn.byPerson.filter((p) => p.userId !== viewerId && p.todos.some((t) => t.group === 'personal')).length
  const toDecide = myTodos.filter((t) => t.kind === 'org_decide').length
  const toBook = myTodos.filter((t) => t.kind === 'org_book').length
  // The freeze to-do blocks everyone's payment even though it is the organiser's job.
  const blocked = waitingOn.byItem.reduce((max, i) => Math.max(max, i.unblocks ?? 0), 0)

  const lines: string[] = []
  for (const item of waitingOn.byItem) {
    if (item.group !== 'personal') continue
    const others = item.userIds.filter((id) => id !== viewerId)
    if (others.length === 0) continue
    lines.push(summaryLine(item, others, nameOf))
    if (lines.length === MAX_LINES) break
  }

  const nothing = people === 0 && toDecide === 0 && toBook === 0 && blocked === 0
  let headline: string
  if (nothing) headline = `As organizer: ${WAITING_ON_EMPTY}`
  else if (people === 0 && toDecide === 0 && toBook === 0) headline = `As organizer: ${blockedMoneyText(blocked)}`
  else headline = blocked > 0 ? `${organiserSummary(people, toDecide, toBook)} · ${blockedMoneyText(blocked)}` : organiserSummary(people, toDecide, toBook)
  return { headline, lines, nothing }
}
