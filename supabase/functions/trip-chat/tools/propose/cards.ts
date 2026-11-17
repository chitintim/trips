/**
 * The card contract: what each chat_actions row carries in `params` (what the
 * client executor needs to call the shared mutation function), `preview`
 * (ground truth for the card, computed here from structured data and live DB
 * reads, never from model prose) and `basis` (what to re-check at render and
 * at Confirm to detect a stale card).
 *
 * Documented field by field in scratchpad/trip-chat-cards-fragment.md.
 */

export type ActionKind =
  | 'add_todo'
  | 'tick_todo'
  | 'answer'
  | 'add_expense'
  | 'suggest_option'
  | 'create_question'
  | 'add_option'
  | 'open_screen'

/** Kinds stored as chat_actions rows (open_screen is not). */
export type StoredKind = Exclude<ActionKind, 'open_screen'>

export interface PersonRef {
  user_id: string
  name: string
}

/** Where a quoted content field came from when it was copied from trip data written by someone else. */
export interface ContentOrigin {
  author_id: string
  author_name: string
  source: 'todo' | 'option' | 'expense'
}

/** Fields shared by every basis. */
export interface BasisCommon {
  /** ISO time the proposal was built. */
  captured_at: string
  /** trips.settlement_snapshot was non-null when proposed. */
  trip_frozen: boolean
  /** Effective stage was Finished when proposed. */
  trip_finished: boolean
  /** The owner was out (declined/cancelled/removed) when proposed. */
  i_am_out: boolean
}

// ---------------------------------------------------------------------------
// add_todo
// ---------------------------------------------------------------------------

/** Mirrors todoModel TodoFormValues: the client builds columns with buildActionColumns. */
export interface AddTodoParams {
  title: string
  notes: string | null
  /** 'person' = named person (assigned_to), 'everyone' = a completion row per person, 'anyone' = who_mode 'anyone'. */
  mode: 'everyone' | 'person' | 'anyone'
  /** The assignee when mode is 'person' (may be the owner), else null. */
  person_id: string | null
  /** deadline_kind 'before_trip' (due date null). */
  before_trip: boolean
  /** YYYY-MM-DD when a fixed date, else null. */
  due_date: string | null
  /** Linked question (planning_sections.id) or null. */
  section_id: string | null
}

export interface AddTodoPreview {
  title: string
  notes: string | null
  mode: AddTodoParams['mode']
  /** "You", "Sam", "Everyone" or "Anyone — first to grab it". */
  who_label: string
  who: PersonRef | null
  /** "Fri 21 Nov" / "Before the trip (Sat 5 Dec)" / null. */
  due_label: string | null
  /** When the existing reminder emails go out, in words, or null when there is no due date. */
  reminder_words: string | null
  question_title: string | null
  content_origin: Record<string, ContentOrigin>
}

export interface AddTodoBasis extends BasisCommon {
  /** The named person is still an active participant (null when mode is not 'person'). */
  assignee_active: boolean | null
  section_status: string | null
  section_updated_at: string | null
}

// ---------------------------------------------------------------------------
// tick_todo
// ---------------------------------------------------------------------------

export type TickOp = 'tick' | 'untick' | 'claim' | 'give_back'

/**
 * Self-only. Executor: tick/untick action -> toggleTodo(tripId, {actionId: id, isGroupAction, userId, done, anyone});
 * claim/give_back action -> claimTodo({id, userId, claim}); checklist -> toggleChecklistItem({id, done, doneBy: userId})
 * / claimChecklistItem({id, userId, claim}).
 */
export interface TickTodoParams {
  source: 'action' | 'checklist'
  id: string
  op: TickOp
  /** The owner (always the signed-in person). */
  user_id: string
  /** Everyone-mode to-do: ticking is my own completion row. */
  is_group_action: boolean
  /** Anyone-mode to-do (ticked through claim_todo). */
  anyone: boolean
  /** tick -> true, untick -> false, claim/give_back -> null. */
  done: boolean | null
  /** claim -> true, give_back -> false, tick/untick -> null. */
  claim: boolean | null
}

export interface TickTodoPreview {
  title: string
  op_label: string
  /** "Open" or "Done" before the change. */
  current_state: 'open' | 'done'
  content_origin: Record<string, ContentOrigin>
}

export interface TickTodoBasis extends BasisCommon {
  completed_at: string | null
  /** Everyone mode: I already have a completion row. */
  my_completion: boolean | null
  assigned_to: string | null
  done: boolean | null
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------

export type AnswerMode = 'single' | 'any' | 'ranked' | 'own'

/** The shape of answerModel's AnswerAction, ready to feed planAnswer one after another (re-plan from live state each time). */
export type AnswerActionJson =
  | { type: 'pick'; optionId: string }
  | { type: 'clear' }
  | { type: 'pass' }
  | { type: 'unpass' }
  | { type: 'save_own'; items: Array<{ optionId: string; checked: true; variant: string | null; quantity: number }> }

export interface AnswerParams {
  section_id: string
  mode: AnswerMode
  op: 'pick' | 'pass' | 'clear'
  /** Desired final picks, in rank order for ranked questions. Empty for pass/clear/own. */
  option_ids: string[]
  /** Rank per option_ids entry (1..n) for ranked; else null. */
  ranks: number[] | null
  /** Own choice: the complete desired order. */
  own_choice: Array<{ option_id: string; quantity: number; variant: string | null }> | null
  /** 'no_preference' | 'none_for_me' for op 'pass', else null. */
  pass_kind: 'no_preference' | 'none_for_me' | null
  /**
   * Run in order via answerQuestion(). Each is planned from the live data at that moment:
   * single -> [pick]; any/ranked -> [clear, pick...] (clear is omitted if I had no answer); own -> [save_own];
   * pass -> [pass]; clear -> [clear].
   */
  answer_actions: AnswerActionJson[]
}

export interface AnswerChosenRow {
  option_id: string
  title: string
  rank: number | null
  quantity: number | null
  variant: string | null
}

export interface AnswerPreview {
  question_title: string
  mode_label: string
  op_label: string
  chosen: AnswerChosenRow[]
  /** What this replaces ("Wahaca", "Dishoom (1st), Wahaca (2nd)", "No preference") or null when I had no answer. */
  replaces_text: string | null
  replaces: AnswerChosenRow[] | null
  replaces_pass: 'no_preference' | 'none_for_me' | null
  deadline: string | null
  content_origin: Record<string, ContentOrigin>
}

export interface AnswerBasis extends BasisCommon {
  section_status: string
  section_updated_at: string | null
  /** option id -> status at propose time. */
  option_status: Record<string, string>
  /** My answer at propose time (to detect that it changed under the card), in PreviousAnswer shape. */
  my_previous: {
    votes: Array<{ optionId: string; rank: number | null }>
    pass: 'no_preference' | 'none_for_me' | null
    selections: Array<{ optionId: string; metadata: unknown }>
  }
}

// ---------------------------------------------------------------------------
// add_expense
// ---------------------------------------------------------------------------

export interface AddExpenseParams {
  description: string
  /** Exact integer minor units of `currency`. */
  amount_minor: number
  currency: string
  /** Decimal places of `currency` (so the client can fromMinorUnits). */
  exponent: number
  paid_by: string
  /** YYYY-MM-DD */
  payment_date: string
  category: 'accommodation' | 'transport' | 'food' | 'activities' | 'equipment' | 'other'
  /** 'equal' = split evenly (largest remainder, extra pennies to the first people in roster order); 'custom' = the explicit amounts below. */
  split_mode: 'equal' | 'custom'
  /** participantIds in the order the shares were computed. */
  participant_ids: string[]
  /** Sums EXACTLY to amount_minor. */
  splits: Array<{ user_id: string; amount_minor: number }>
  base_currency: string
  /** currency !== base_currency: the client resolves FX (resolveExpenseFxFields) when it executes. */
  needs_fx: boolean
}

export interface AddExpensePreview {
  description: string
  amount_text: string
  currency: string
  paid_by: PersonRef
  paid_by_is_me: boolean
  /** Same as paid_by_is_me (explicit name for the "you'll owe them" line): false = someone else paid. */
  payer_is_user: boolean
  /** The asker's own share of the total in the expense currency, or null when they are not in the split. */
  my_share_minor: number | null
  my_share_text: string | null
  date: string
  date_label: string
  category: string
  split_mode: 'equal' | 'custom'
  shares: Array<{ user_id: string; name: string; amount_minor: number; amount_text: string }>
  shares_total_text: string
  /** Set when currency differs from the trip's: "The app converts this to GBP at the exchange rate for the payment date when you confirm." */
  fx_note: string | null
  /** A similar expense (same description, amount, date, payer) already exists. */
  possible_duplicate: { expense_id: string } | null
  content_origin: Record<string, ContentOrigin>
}

export interface AddExpenseBasis extends BasisCommon {
  /** Each split person still active at propose time. */
  people_active: Record<string, boolean>
}

// ---------------------------------------------------------------------------
// suggest_option
// ---------------------------------------------------------------------------

/** Executor: suggestOption(tripId, {sectionId: section_id, title, link, note, idea}). */
export interface SuggestOptionParams {
  /** null with idea=true -> the trip's Ideas question. */
  section_id: string | null
  idea: boolean
  title: string
  note: string | null
  /** Normalised http(s) address or null. */
  link: string | null
}

export interface SuggestOptionPreview {
  title: string
  note: string | null
  link: string | null
  question_title: string
  is_idea: boolean
  content_origin: Record<string, ContentOrigin>
}

export interface SuggestOptionBasis extends BasisCommon {
  section_status: string | null
  section_updated_at: string | null
  option_count: number | null
  my_suggestions: number | null
}

// ---------------------------------------------------------------------------
// create_question / add_option
// ---------------------------------------------------------------------------

export interface QuestionOptionParams {
  title: string
  note: string | null
  /** Exact decimal string ("120.00") in `currency`, or null. */
  price: string | null
  price_minor: number | null
}

/** Mirrors addFlow QuestionValues: executor builds buildSectionInsert / buildQuestionOptionRows (note -> options.description). */
export interface CreateQuestionParams {
  title: string
  /** 'vote' = Group choice, 'personal' = Own choice. */
  shape: 'vote' | 'personal'
  method: 'single' | 'approval' | 'ranked'
  section_type: string
  /** ISO date-time or null. */
  answer_by: string | null
  hide_results: boolean
  /** One currency for every priced option. */
  currency: string
  /** 'each' | 'total_split' */
  price_basis: 'each' | 'total_split'
  options: QuestionOptionParams[]
}

export interface CreateQuestionPreview {
  title: string
  shape_label: string
  method_label: string
  deadline_label: string | null
  options: Array<{ title: string; note: string | null; price_text: string | null; basis_text: string | null }>
  content_origin: Record<string, ContentOrigin>
}

export type CreateQuestionBasis = BasisCommon

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

export interface AddOptionPreview {
  question_title: string
  title: string
  note: string | null
  price_text: string | null
  basis_text: string | null
  existing_option_count: number
  content_origin: Record<string, ContentOrigin>
}

export interface AddOptionBasis extends BasisCommon {
  section_status: string
  section_updated_at: string | null
  option_count: number
}

// ---------------------------------------------------------------------------
// open_screen (not stored; emitted as an envelope with requires 'link')
// ---------------------------------------------------------------------------

export interface OpenScreenParams {
  target: string
  id: string | null
  /** The exact `?open=` value (formatOpenParam). */
  open_param: string
}

export interface OpenScreenPreview {
  /** Plain words, no trip text: "Open the question". */
  label: string
  /** Title of the thing it opens when it has one (trip text; for the card only, never sent to the model). */
  subject: string | null
}
