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
    events: [],
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

export const travelParams = (over: Record<string, unknown> = {}) => ({
  id: null,
  direction: 'arrival',
  leg: 'main',
  title: null,
  date: '2026-12-03',
  time: '10:00',
  flight_ref: 'JL044',
  airport_code: 'HND',
  set_off_date: '2026-12-02',
  set_off_time: '21:00',
  home_date: null,
  home_time: null,
  replaces_event_id: null,
  ...over,
})

export const planItemParams = (over: Record<string, unknown> = {}) => ({
  title: 'Dinner in Tokyo',
  date: '2026-12-02',
  start_time: '19:00',
  end_time: '21:00',
  for: 'me',
  notes: null,
  ...over,
})

/** A saved travel row of the signed-in person, as the timeline query returns it. */
export function travelEvent(over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): NonNullable<LiveData['events']>[number] {
  return {
    id: 'ev-arr',
    trip_id: 't1',
    event_date: '2026-12-04',
    start_time: '09:30:00',
    end_time: null,
    all_day: false,
    title: 'Arrival',
    description: null,
    category: 'flight',
    location: null,
    participant_ids: [ME],
    metadata: { travel_details: true, direction: 'arrival', flight_ref: 'BA117', ...meta },
    sort_order: 0,
    source_option_id: null,
    created_by: ME,
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-02T10:00:00Z',
    place_id: null,
    ...over,
  } as NonNullable<LiveData['events']>[number]
}
