import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RsvpStandingNotice } from './RsvpStandingNotice'
import { standingReplacesAnswerButton } from '../lib/peopleSummary'
import { rsvpStanding, tripPlaces, type RsvpPersonInput } from '../lib/rsvpStanding'

const NOW = new Date(2026, 10, 16, 12, 0, 0)
const trip = { confirmation_enabled: true, confirmation_deadline: null, capacity_limit: 2 }

function standingFor(status: string, others: string[]) {
  const list: RsvpPersonInput[] = [...others, status].map((s, i) => ({ user_id: `u${i}`, active: true, confirmation_status: s }))
  return rsvpStanding({
    trip,
    stage: 'confirming_participants',
    person: list[list.length - 1],
    places: tripPlaces(trip, list),
    today: '2026-11-16',
    now: NOW,
  })
}
const render = (s: ReturnType<typeof standingFor>) =>
  renderToStaticMarkup(<RsvpStandingNotice standing={s} tripName="Japow" onAnswer={() => {}} />)

describe('RsvpStandingNotice', () => {
  it('shows the calm line with both buttons for a maybe on a full trip', () => {
    const s = standingFor('interested', ['confirmed', 'confirmed'])
    const html = render(s)
    expect(standingReplacesAnswerButton(s)).toBe(true)
    expect(html).toContain("Japow is full. You&#x27;re down as not sure, so there&#x27;s nothing you need to do.")
    expect(html).toContain('I&#x27;d still like to come')
    expect(html).toContain('I&#x27;m out')
  })

  it('offers only "I\'m out" while a freed place is going to the waitlist first', () => {
    const s = standingFor('interested', ['confirmed', 'waitlist'])
    expect(s.placeBeingOffered).toBe(true)
    const html = render(s)
    expect(html).not.toContain('still like to come')
    expect(html).toContain('I&#x27;m out')
  })

  it('renders nothing when there is no line (an open question)', () => {
    expect(render(standingFor('pending', ['confirmed']))).toBe('')
  })

  it('gives a plain waitlister the line only, keeping the usual button', () => {
    const s = standingFor('waitlist', ['confirmed', 'confirmed'])
    expect(standingReplacesAnswerButton(s)).toBe(false)
    expect(render(s)).not.toContain('<button')
  })
})
