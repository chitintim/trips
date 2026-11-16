/**
 * Where the Manage sheet opens when it is reached from a deep link or a to-do
 * ("Decide: X", "Tie: choose a winner", "Close answers for X", "Book: X"):
 * straight into the Decide step or the Mark booked step, or on its home view
 * when that step no longer makes sense (fail-soft). Pure; unit-tested.
 */
export type ManageInitialChild = 'decide' | 'booking'

export interface InitialChildSection {
  status: string | null
  /** Live (not cancelled) options with their own status. */
  options: ReadonlyArray<{ id: string; status: string | null }>
  /** Own choice: nothing to decide a winner for and nothing to book. */
  own: boolean
  /** The decided option, when one is recorded. */
  decidedOptionId: string | null
}

export interface PlanInitialChildInput {
  initialChild?: ManageInitialChild | null
  initialOptionId?: string | null
  canManage: boolean
  finished: boolean
  section: InitialChildSection
}

export type PlannedChild = { child: 'decide' } | { child: 'mark_booked'; optionId: string } | { child: null }

export function planInitialChild(input: PlanInitialChildInput): PlannedChild {
  const { initialChild, initialOptionId, canManage, finished, section } = input
  if (!initialChild || !canManage || finished) return { child: null }
  const live = section.options.filter((o) => o.status !== 'cancelled')
  if (initialChild === 'decide') {
    // Only an open question can be decided or closed; a decided one opens on Manage's home.
    if (section.status === 'completed' || (!section.own && live.length === 0)) return { child: null }
    return { child: 'decide' }
  }
  // 'booking': the question must be decided (group choice) and the option in the link still bookable.
  if (section.status !== 'completed' || section.own) return { child: null }
  const optionId = initialOptionId ?? section.decidedOptionId
  const option = optionId ? live.find((o) => o.id === optionId) : undefined
  if (!option || option.status === 'booked') return { child: null }
  return { child: 'mark_booked', optionId: option.id }
}
