/**
 * Test fixtures for the answer model, shaped after real trips:
 *   - rankedStay:    a ranked Group choice (3 stay options, ranked voting)
 *   - tripDates:     the "Trip dates" date question (single vote, options carry date_range)
 *   - legacySkiRental: a legacy migrated Own-choice "order" with per-day
 *     rates, variants and quantities (the Meribel ski rental), with Sam's
 *     existing order: 2 adult skis for 6 days.
 * Plain data, no React, safe to import from any test.
 */
import type { ModelOption, ModelSection, ModelVote } from './answerModel'

export const TRIP_ID = 'trip-1'

export function option(id: string, title: string, extra: Partial<ModelOption> = {}): ModelOption {
  return { id, title, status: 'available', locked: false, price: null, currency: 'GBP', price_type: 'per_person_fixed', metadata: {}, order_index: 0, selections: [], ...extra }
}

export function section(id: string, extra: Partial<ModelSection> & { title?: string; options: ModelOption[] }): ModelSection & { title: string } {
  return {
    id,
    status: 'in_progress',
    metadata: {},
    voting_method: 'single',
    vote_deadline: null,
    hide_votes_until_close: false,
    ...extra,
    title: extra.title ?? id,
  }
}

export function vote(id: string, optionId: string, userId: string, rank: number | null = null): ModelVote {
  return { id, option_id: optionId, user_id: userId, rank, created_at: '2026-11-01T10:00:00Z' }
}

// ---- ranked group choice ---------------------------------------------------
export const rankedStay = section('s-stay', {
  title: 'Where are we staying in Osaka?',
  voting_method: 'ranked',
  options: [
    option('o-airbnb', 'Osaka Airbnb (17–21 Aug)', { price: 420, price_type: 'total_split', order_index: 0 }),
    option('o-granvia', 'Hotel Granvia', { price: 95, order_index: 1 }),
    option('o-ryokan', 'Ryokan Kurashiki', { price: 120, order_index: 2 }),
  ],
})

// ---- date question ----------------------------------------------------------
export const tripDates = section('s-dates', {
  title: 'Trip dates',
  voting_method: 'single',
  options: [
    option('d-aug1', '17–21 Aug', { metadata: { date_range: { start: '2026-08-17', end: '2026-08-21' } }, order_index: 0 }),
    option('d-aug2', '24–28 Aug', { metadata: { date_range: { start: '2026-08-24', end: '2026-08-28' } }, order_index: 1 }),
    option('d-sep', '28 Aug – 3 Sep', { metadata: { date_range: { start: '2026-08-28', end: '2026-09-03' } }, order_index: 2 }),
  ],
})

// ---- legacy own-choice order with quantities --------------------------------
export function legacySkiRental(userId = 'sam'): ModelSection & { title: string } {
  return section('s-ski', {
    title: 'Ski rental',
    metadata: { decision_shape: 'personal', legacy_migrated: true },
    options: [
      option('k-skis', 'Skis + boots', {
        currency: 'EUR',
        metadata: { pricing: { per_day: 28, variants: [{ label: 'Adult', per_day: 28 }, { label: 'Kids', per_day: 18 }] } },
        selections: [
          { id: 'sel-skis', user_id: userId, metadata: { start_date: '2027-02-06', end_date: '2027-02-11', variant: 'Adult', quantity: 2 } },
          { id: 'sel-other', user_id: 'tim', metadata: {} },
        ],
      }),
      option('k-helmet', 'Helmet', { currency: 'EUR', metadata: { pricing: { flat: 12 } }, selections: [] }),
      option('k-poles', 'Poles', { currency: 'EUR', metadata: {}, selections: [] }),
    ],
  })
}
