import type { QueryClient } from '@tanstack/react-query'
import type { ChatActionEnvelope } from '../lib/payload'
import type { SectionWithOptions, OptionVoteWithUser, QuestionPass } from '../../../lib/queries/usePlanning'
import type { ActionWithCompletions } from '../../../lib/queries/useActions'
import type { ChecklistItem } from '../../../lib/queries/useChecklists'
import type { LogActivityInput } from '../../organizer/lib/activity'
import type { ChatDeps } from './deps'

/** One person on the trip as the cards need them. */
export interface LivePerson {
  user_id: string
  name: string
  active: boolean
  confirmation_status: string | null
}

/** The app's own live data (query cache) the cards are rendered and re-checked against. Never the model's words. */
export interface LiveData {
  userId: string
  tripId: string
  frozen: boolean
  finished: boolean
  baseCurrency: string
  canManage: boolean
  /** The who_mode migration is applied (Anyone to-dos, optional due dates). */
  todoWho: boolean
  roster: LivePerson[]
  sections: SectionWithOptions[]
  votes: OptionVoteWithUser[]
  /** undefined = passes are not available yet (never write or clear one). */
  passes: QuestionPass[] | undefined
  actions: ActionWithCompletions[]
  checklists: ChecklistItem[]
  /** The clock the cards judge dates against (tests set it). */
  now?: Date
}

export interface CardRow {
  label: string
  value: string
  /** Free text that is the point of the action (a title, a note): shown quoted, as content. */
  quoted?: boolean
  /** Key into the server's `content_origin` (which field this quoted text is). */
  field?: string
  /** Set when the quoted text was written by someone else on the trip: "from Sam's note". */
  from?: string
  /** Extra lines under the value (per-person shares). */
  lines?: string[]
}

export interface CardView {
  icon: string
  title: string
  rows: CardRow[]
  /** One-line summary for the compact tap card. */
  line: string
  confirmLabel: string
  /** Plain notes under the rows (e.g. "Option notes are not saved from chat"). */
  notes: string[]
  /** Loud lines the person should read before confirming (who is owed, a suspicious date). */
  warnings?: string[]
}

export interface ExecCtx {
  tripId: string
  userId: string
  queryClient: QueryClient
  /** Fresh live data (read again after `refresh`). */
  live: () => LiveData
  /** Refetch what the answer planner reads (questions, votes, passes, to-dos) so each step plans from the true state. */
  refresh: () => Promise<void>
  logActivity: (input: LogActivityInput) => void
  deps: ChatDeps
  now: () => Date
}

export interface ExecOutcome {
  /** Stored with the action (<= 16 KB): created ids and the undo data. */
  result: Record<string, unknown>
  /** Short plain confirmation. */
  doneText: string
}

export interface ActionModule {
  /** Cheap shape check of `params`. A card whose params fail it shows no Confirm. */
  validate(params: Record<string, unknown>): boolean
  view(action: ChatActionEnvelope, live: LiveData): CardView
  /** Why this suggestion is no longer safe to run (against live data), or null. */
  recheck(action: ChatActionEnvelope, live: LiveData): string | null
  /**
   * Why Undo must NOT be offered now (the thing the action wrote has since been changed by someone), or null when it is still safe.
   * Checked against live data both when the button is drawn and again, after a refresh, when it is tapped.
   */
  undoBlocked?(action: ChatActionEnvelope, live: LiveData): string | null
  execute(action: ChatActionEnvelope, ctx: ExecCtx): Promise<ExecOutcome>
  /** Reverse a finished action from its stored `result`. Absent = no Undo for this kind. */
  undo?(action: ChatActionEnvelope, ctx: ExecCtx): Promise<void>
  /** Refresh what the write changes. */
  invalidate(ctx: ExecCtx): void
}
