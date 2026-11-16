import { describe, expect, it } from 'vitest'
import { buildAnswersText, buildEveryonesAnswers, groupTotalText, linePriceText, type EAParticipant } from './everyonesAnswers'
import { legacySkiRental, rankedStay, vote } from './answerFixtures'

const people: EAParticipant[] = [
  { user_id: 'sam', user: { full_name: 'Sam' } },
  { user_id: 'tim', user: { full_name: 'Tim' } },
  { user_id: 'amy', user: { full_name: 'Amy' } },
  { user_id: 'gone', active: false, user: { full_name: 'Gone' } },
]

describe('buildEveryonesAnswers', () => {
  it('group choice: lists who picked what, in rank order, and who has not answered', () => {
    const [a, b] = rankedStay.options
    const data = buildEveryonesAnswers({
      section: rankedStay,
      votes: [vote('v1', a.id, 'sam', 2), vote('v2', b.id, 'sam', 1), vote('v3', a.id, 'tim', 1)],
      passes: [],
      participants: people,
      fallbackCurrency: 'GBP',
    })
    expect(data.shape).toBe('group')
    expect(data.ranked).toBe(true)
    const sam = data.people.find((p) => p.userId === 'sam')!
    expect(sam.optionIds).toEqual([b.id, a.id])
    expect(data.waiting.map((w) => w.name)).toEqual(['Amy'])
    expect(data.people.some((p) => p.userId === 'gone')).toBe(false)
    expect(data.perOption.find((o) => o.optionId === a.id)?.count).toBe(2)
  })

  it('counts a pass as answered-without-choice, not as waiting', () => {
    const data = buildEveryonesAnswers({
      section: rankedStay,
      votes: [],
      passes: [{ section_id: rankedStay.id, user_id: 'amy', kind: 'no_preference' }],
      participants: people,
      fallbackCurrency: 'GBP',
    })
    const amy = data.people.find((p) => p.userId === 'amy')!
    expect(amy.state).toBe('passed')
    expect(amy.passLabel).toBe('No preference')
    expect(data.passedCount).toBe(1)
    expect(data.waiting).toHaveLength(2)
  })

  it('own choice (legacy ski rental): order lines, per-item totals and group total', () => {
    const data = buildEveryonesAnswers({ section: legacySkiRental('sam'), votes: [], passes: [], participants: people, fallbackCurrency: 'EUR' })
    expect(data.shape).toBe('own')
    const sam = data.people.find((p) => p.userId === 'sam')!
    expect(sam.lines).toHaveLength(1)
    expect(sam.lines[0].variant).toBe('Adult')
    expect(sam.lines[0].quantity).toBe(2)
    expect(sam.lines[0].total).toBeGreaterThan(0)
    const skis = data.itemTotals.find((t) => t.optionId === 'k-skis')!
    expect(skis.count).toBe(2)
    expect(skis.quantity).toBe(3)
    expect(data.groupTotals.EUR).toBeGreaterThan(0)
    expect(data.waiting.map((w) => w.name)).toEqual(['Amy'])
  })

  it('buildAnswersText includes totals and the not-answered list', () => {
    const data = buildEveryonesAnswers({ section: legacySkiRental('sam'), votes: [], passes: [], participants: people, fallbackCurrency: 'EUR' })
    const text = buildAnswersText('Ski rental', data)
    expect(text).toMatch(/^Ski rental - answers/)
    expect(text).toMatch(/Group total:/)
    expect(text).toMatch(/Not answered yet: Amy/)
  })

  it('own choice with nothing priced: no £0 anywhere, no Group total', () => {
    const base = legacySkiRental('sam')
    const section = { ...base, options: base.options.map((o) => ({ ...o, price: null, metadata: null })) }
    const data = buildEveryonesAnswers({ section, votes: [], passes: [], participants: people, fallbackCurrency: 'GBP' })
    expect(data.groupTotals).toEqual({})
    expect(groupTotalText(data.groupTotals)).toBeNull()
    expect(data.itemTotals.every((t) => !t.priced)).toBe(true)
    for (const l of data.people.flatMap((p) => p.lines)) expect(linePriceText(l)).toBeNull()
    const text = buildAnswersText('Ski rental', data)
    expect(text).not.toMatch(/Group total/)
    expect(text).not.toMatch(/£0|0\.00/)
    expect(text).toMatch(/No price set/)
  })
})
