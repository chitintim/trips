/**
 * The structured action the assistant proposes, as the client receives it (the `action` stream event, or a refetch of
 * `chat_actions`). It mirrors the server's card contract (supabase/functions/trip-chat/tools/propose/cards.ts): `params`
 * is what the executor runs, `basis` is what is re-checked before running, `preview` is only a fallback / audit copy.
 *
 * Nothing here ever carries model prose: the cards are built from `params` plus the app's own live data.
 */

export type ActionKind = 'add_todo' | 'tick_todo' | 'answer' | 'add_expense' | 'suggest_option' | 'create_question' | 'add_option' | 'set_travel' | 'add_plan_item' | 'open_screen'

export const ACTION_KINDS: readonly ActionKind[] = ['add_todo', 'tick_todo', 'answer', 'add_expense', 'suggest_option', 'create_question', 'add_option', 'set_travel', 'add_plan_item', 'open_screen']

export type ActionStatus = 'proposed' | 'executing' | 'done' | 'failed' | 'dismissed' | 'expired' | 'edited_elsewhere'
const STATUSES: readonly string[] = ['proposed', 'executing', 'done', 'failed', 'dismissed', 'expired', 'edited_elsewhere']

export type ActionTier = 'tap' | 'review' | 'link'

export interface ChatActionEnvelope {
  id: string
  kind: ActionKind
  params: Record<string, unknown>
  preview: Record<string, unknown>
  basis: Record<string, unknown>
  requires: ActionTier
  status: ActionStatus
  result: Record<string, unknown> | null
  error: string | null
  edited: boolean
  turn_id: string | null
  created_at: string | null
  expires_at: string | null
  started_at: string | null
  finished_at: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** Reads one action from untrusted JSON (a stream event or a table row). Anything that is not a known, well-formed action is dropped (null). */
export function parseEnvelope(raw: unknown): ChatActionEnvelope | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  const kind = str(raw.kind)
  if (!id || !kind || !(ACTION_KINDS as readonly string[]).includes(kind)) return null
  const params = isObj(raw.params) ? raw.params : null
  if (!params) return null
  const requiresRaw = str(raw.requires)
  const requires: ActionTier = kind === 'open_screen' ? 'link' : requiresRaw === 'tap' ? 'tap' : 'review' // unknown tier: the safer, fuller card
  const statusRaw = str(raw.status) ?? 'proposed'
  return {
    id,
    kind: kind as ActionKind,
    params,
    preview: isObj(raw.preview) ? raw.preview : {},
    basis: isObj(raw.basis) ? raw.basis : {},
    requires,
    status: (STATUSES.includes(statusRaw) ? statusRaw : 'proposed') as ActionStatus,
    result: isObj(raw.result) ? raw.result : null,
    error: str(raw.error),
    edited: raw.edited === true,
    turn_id: str(raw.turn_id),
    created_at: str(raw.created_at),
    expires_at: str(raw.expires_at),
    started_at: str(raw.started_at),
    finished_at: str(raw.finished_at),
  }
}

// ---------------------------------------------------------------------------
// params per kind (see cards.ts for the field-by-field meaning)
// ---------------------------------------------------------------------------

export interface AddTodoParams {
  title: string
  notes: string | null
  mode: 'everyone' | 'person' | 'anyone'
  person_id: string | null
  before_trip: boolean
  due_date: string | null
  section_id: string | null
}

export type TickOp = 'tick' | 'untick' | 'claim' | 'give_back'
export interface TickTodoParams {
  source: 'action' | 'checklist'
  id: string
  op: TickOp
  user_id: string
  is_group_action: boolean
  anyone: boolean
  done: boolean | null
  claim: boolean | null
}

export type AnswerActionJson =
  | { type: 'pick'; optionId: string }
  | { type: 'clear' }
  | { type: 'pass' }
  | { type: 'unpass' }
  | { type: 'save_own'; items: Array<{ optionId: string; checked: true; variant: string | null; quantity: number }> }

export interface AnswerParams {
  section_id: string
  mode: 'single' | 'any' | 'ranked' | 'own'
  op: 'pick' | 'pass' | 'clear'
  option_ids: string[]
  ranks: number[] | null
  own_choice: Array<{ option_id: string; quantity: number; variant: string | null }> | null
  pass_kind: 'no_preference' | 'none_for_me' | null
  answer_actions: AnswerActionJson[]
}

export interface AddExpenseParams {
  description: string
  amount_minor: number
  currency: string
  exponent: number
  paid_by: string
  payment_date: string
  category: 'accommodation' | 'transport' | 'food' | 'activities' | 'equipment' | 'other'
  split_mode: 'equal' | 'custom'
  participant_ids: string[]
  splits: Array<{ user_id: string; amount_minor: number }>
  base_currency: string
  needs_fx: boolean
}

export interface SuggestOptionParams {
  section_id: string | null
  idea: boolean
  title: string
  note: string | null
  link: string | null
}

export interface QuestionOptionParams {
  title: string
  note: string | null
  price: string | null
  price_minor: number | null
}

export interface CreateQuestionParams {
  title: string
  shape: 'vote' | 'personal'
  method: 'single' | 'approval' | 'ranked'
  section_type: string
  answer_by: string | null
  hide_results: boolean
  currency: string
  price_basis: 'each' | 'total_split'
  options: QuestionOptionParams[]
}

export interface AddOptionParams {
  section_id: string
  shape: 'vote' | 'personal'
  title: string
  note: string | null
  price: string | null
  price_minor: number | null
  currency: string | null
  price_basis: 'each' | 'total_split' | null
}

export interface SetTravelParams {
  id: string | null
  direction: 'arrival' | 'departure'
  leg: 'main' | 'extra'
  title: string | null
  date: string
  time: string | null
  flight_ref: string | null
  airport_code: string | null
  set_off_date: string | null
  set_off_time: string | null
  home_date: string | null
  home_time: string | null
  replaces_event_id: string | null
}

export interface AddPlanItemParams {
  title: string
  date: string
  start_time: string | null
  end_time: string | null
  for: 'me' | 'everyone'
  notes: string | null
}

export interface OpenScreenParams {
  target: string
  id: string | null
  open_param: string
}
