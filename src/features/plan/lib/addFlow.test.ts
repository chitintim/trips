import { describe, it, expect } from 'vitest'
import {
  availableIntents, asPastedUrl, parseOptionLines, guessCategory, emptyHappening, validateHappening, buildEventInsert,
  emptyQuestion, applyTemplate, validateQuestion, buildSectionInsert, buildQuestionOptionRows,
  emptyIdea, validateIdea, findIdeasQuestion, buildIdeasSectionInsert, buildIdeaOptionRow, viewLink, INTENT_TILES,
} from './addFlow'

describe('addFlow', () => {
  it('offers nothing to people who cannot manage the trip', () => {
    expect(availableIntents(false)).toEqual([])
    expect(availableIntents(true)).toEqual(['happening', 'question', 'idea'])
    expect(availableIntents(true, true)).toEqual(['happening'])
    // Phase 5A: a participant who may suggest gets exactly one intent; never on a finished trip; organizers keep all three.
    expect(availableIntents(false, false, true)).toEqual(['idea'])
    expect(availableIntents(false, true, true)).toEqual([])
    expect(availableIntents(false, false, false)).toEqual([])
    expect(availableIntents(true, false, true)).toEqual(['happening', 'question', 'idea'])
    expect(INTENT_TILES.map((t) => t.title)).toEqual(['Something that’s happening', 'A question for the group', 'An idea'])
  })

  it('recognises a pasted link only when it is the whole text', () => {
    expect(asPastedUrl(' https://airbnb.com/rooms/1 ')).toBe('https://airbnb.com/rooms/1')
    expect(asPastedUrl('www.booking.com/x')).toBe('https://www.booking.com/x')
    expect(asPastedUrl('Dinner at https://x.com')).toBeNull()
    expect(asPastedUrl('Dinner')).toBeNull()
  })

  it('parses one option per line, dropping bullets, blanks and duplicates', () => {
    expect(parseOptionLines('- Osaka\n2. Kyoto\n\n• osaka\n  Nara  \n')).toEqual(['Osaka', 'Kyoto', 'Nara'])
  })

  it('guesses a type from the title', () => {
    expect(guessCategory('Flight to Tokyo')).toBe('flight')
    expect(guessCategory('Dinner at Kumo')).toBe('dining')
    expect(guessCategory('Airport shuttle')).toBe('transfer')
    expect(guessCategory('Something odd')).toBe('other')
  })

  it('needs only a title and a day for an event, and saves cost via metadata.cost', () => {
    const v = emptyHappening('2026-12-01', 'GBP')
    expect(validateHappening(v)).toMatch(/title/)
    v.title = 'Dinner at Kumo'
    expect(validateHappening(v)).toBeNull()
    const row = buildEventInsert(v, 't1', 'u1')
    expect(row).toMatchObject({ trip_id: 't1', created_by: 'u1', event_date: '2026-12-01', all_day: true, start_time: null, category: 'dining', participant_ids: null })
    expect((row.metadata as Record<string, unknown>).cost).toBeUndefined()
    const full = buildEventInsert({ ...v, hasTime: true, startTime: '19:00', costAmount: '40', costBasis: 'total_split', attendeeIds: ['a'] }, 't1', 'u1')
    expect(full).toMatchObject({ all_day: false, start_time: '19:00', participant_ids: ['a'] })
    expect((full.metadata as Record<string, unknown>).cost).toEqual({ amount: 40, currency: 'GBP', basis: 'total_split' })
    expect(validateHappening({ ...v, hasTime: true, startTime: '20:00', endTime: '19:00' })).toMatch(/end time/)
  })

  it('needs a title and two options for a question, with visible results by default', () => {
    const v = emptyQuestion('GBP')
    expect(validateQuestion(v)).toMatch(/question/)
    v.title = 'Where?'
    v.optionsText = 'Osaka'
    expect(validateQuestion(v)).toMatch(/two options/)
    v.optionsText = 'Osaka\nKyoto'
    expect(validateQuestion(v)).toBeNull()
    const section = buildSectionInsert(v)
    expect(section).toMatchObject({ status: 'in_progress', voting_method: 'single', hide_votes_until_close: false, allow_multiple_selections: false, vote_deadline: null })
    expect(section.metadata).toEqual({ decision_shape: 'vote' })
    expect(buildQuestionOptionRows(v, 's1').map((r) => [r.title, r.price, r.order_index])).toEqual([['Osaka', null, 0], ['Kyoto', null, 1]])
  })

  it('templates fill the title and the default price basis', () => {
    const v = applyTemplate(emptyQuestion('GBP'), 'Where are we staying?')
    expect(v).toMatchObject({ title: 'Where are we staying?', sectionType: 'accommodation', basis: 'total_split' })
  })

  it('prices options through the pricing form helpers', () => {
    const v = { ...emptyQuestion('EUR'), title: 'Stay', optionsText: 'A\nB', basis: 'total_split' as const, prices: { a: '900' } }
    const rows = buildQuestionOptionRows(v, 's1')
    expect(rows[0]).toMatchObject({ price: 900, currency: 'EUR', price_type: 'total_split' })
    expect((rows[0].metadata as Record<string, unknown>).price_basis).toBe('total_split')
    expect(rows[1]).toMatchObject({ price: null, currency: null })
    expect(validateQuestion({ ...v, prices: { a: 'abc' } })).toMatch(/^A:/)
  })

  it('own-choice prices are catalog pricing and ignore the group-choice settings', () => {
    const v = { ...emptyQuestion('GBP'), title: 'Gear', optionsText: 'Skis\nBoard', shape: 'personal' as const, method: 'ranked' as const, hideResults: true, prices: { skis: '30' } }
    expect(buildSectionInsert(v)).toMatchObject({ voting_method: 'single', hide_votes_until_close: false })
    expect(buildQuestionOptionRows(v, 's1')[0]).toMatchObject({ price: null, currency: 'GBP', metadata: { pricing: { flat: 30 } } })
  })

  it('stores ideas as options in one Ideas question', () => {
    expect(validateIdea(emptyIdea())).toMatch(/title/)
    expect(validateIdea({ title: 'Teamlab', link: 'nope' })).toMatch(/link/)
    expect(validateIdea({ title: 'Teamlab', link: '' })).toBeNull()
    const sections = [
      { id: 'a', status: 'completed', title: 'Ideas', metadata: { ideas_bucket: true } },
      { id: 'b', status: 'in_progress', title: 'Where?', metadata: null },
      { id: 'c', status: 'in_progress', title: 'Ideas', metadata: { ideas_bucket: true } },
    ]
    expect(findIdeasQuestion(sections)?.id).toBe('c')
    expect(findIdeasQuestion([])).toBeNull()
    expect(buildIdeasSectionInsert()).toMatchObject({ title: 'Ideas', voting_method: 'approval', hide_votes_until_close: false })
    expect(buildIdeaOptionRow({ title: 'Teamlab', link: 'https://teamlab.art' }, 'c').metadata).toEqual({ source: 'link_parse', source_url: 'https://teamlab.art' })
    expect(buildIdeaOptionRow({ title: 'Teamlab', link: '' }, 'c').metadata).toBeNull()
  })

  it('builds the View deep link', () => {
    expect(viewLink('t1', { type: 'question', id: 'q1' })).toBe('/t1?open=question:q1')
    expect(viewLink('t1', { type: 'item', id: 'e1' })).toBe('/t1?open=item:e1')
  })
})
