/** Test fixtures for the chat feature (not shipped: only imported by *.test.ts). */
import type { LiveData } from '../actions/types'
import type { ChatActionEnvelope, ActionKind } from './payload'

export const ME = 'u-tim'
export const SAM = 'u-sam'
export const ANA = 'u-ana'
export const BEN = 'u-ben'

const person = (user_id: string, name: string, active = true) => ({ user_id, name, active, confirmation_status: 'confirmed' as string | null })

export function liveFixture(over: Partial<LiveData> = {}): LiveData {
  return {
    userId: ME,
    tripId: 't1',
    frozen: false,
    finished: false,
    baseCurrency: 'GBP',
    canManage: true,
    todoWho: true,
    roster: [person(ME, 'Tim'), person(SAM, 'Sam'), person(ANA, 'Ana'), person(BEN, 'Ben')],
    sections: [
      {
        id: 'q1',
        title: 'Saturday dinner',
        status: 'in_progress',
        voting_method: 'single',
        vote_deadline: null,
        metadata: { decision_shape: 'vote' },
        options: [
          { id: 'o1', title: 'Dishoom', status: 'active', selections: [] },
          { id: 'o2', title: 'Wahaca', status: 'active', selections: [] },
          { id: 'o3', title: 'Nandos', status: 'active', selections: [] },
        ],
      },
    ] as unknown as LiveData['sections'],
    votes: [],
    passes: [],
    actions: [
      { id: 'a1', title: 'Book the ferry', completed_at: null, assigned_to: ME, trip_action_completions: [] },
      { id: 'a2', title: 'Pack passports', completed_at: null, assigned_to: null, trip_action_completions: [] },
    ] as unknown as LiveData['actions'],
    checklists: [{ id: 'c1', title: 'Sunscreen', done: false, assigned_to: ME }] as unknown as LiveData['checklists'],
    ...over,
  }
}

export function envelope(kind: ActionKind, params: Record<string, unknown>, over: Partial<ChatActionEnvelope> = {}): ChatActionEnvelope {
  return {
    id: `act-${kind}`,
    kind,
    params,
    preview: {},
    basis: {},
    requires: 'review',
    status: 'proposed',
    result: null,
    error: null,
    edited: false,
    turn_id: 'turn-1',
    created_at: '2026-11-17T10:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
    started_at: null,
    finished_at: null,
    ...over,
  }
}

export const expenseParams = (over: Record<string, unknown> = {}) => ({
  description: 'Taxis',
  amount_minor: 4000,
  currency: 'GBP',
  exponent: 2,
  paid_by: ME,
  payment_date: '2026-11-20',
  category: 'transport',
  split_mode: 'equal',
  participant_ids: [ME, SAM, ANA, BEN],
  splits: [
    { user_id: ME, amount_minor: 1000 },
    { user_id: SAM, amount_minor: 1000 },
    { user_id: ANA, amount_minor: 1000 },
    { user_id: BEN, amount_minor: 1000 },
  ],
  base_currency: 'GBP',
  needs_fx: false,
  ...over,
})

export const todoParams = (over: Record<string, unknown> = {}) => ({
  title: 'Book the ferry',
  notes: null,
  mode: 'person',
  person_id: SAM,
  before_trip: false,
  due_date: '2026-11-21',
  section_id: null,
  ...over,
})

export const answerParams = (over: Record<string, unknown> = {}) => ({
  section_id: 'q1',
  mode: 'single',
  op: 'pick',
  option_ids: ['o1'],
  ranks: null,
  own_choice: null,
  pass_kind: null,
  answer_actions: [{ type: 'pick', optionId: 'o1' }],
  ...over,
})
