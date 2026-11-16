/**
 * Unit tests for the digest empty-content guards (2026-07-19 incident: a
 * test digest for a trip with zero open actions rendered and SENT a
 * "0 things need your attention" email). Run with:
 *   deno test supabase/functions/_shared/emailTemplate.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type DigestTripSection, renderDigestEmail } from './emailTemplate.ts'

const APP_URL = 'https://trips.fontem.ai'

function section(overrides: Partial<DigestTripSection>): DigestTripSection {
  return { tripName: 'Trip', tripLink: `${APP_URL}/t`, actionRows: [], otherLines: [], ...overrides }
}

const sampleRow = {
  title: 'Book the ferry',
  deadlineLabel: 'Fri 1 Aug',
  chipLabel: 'Due in 6 days',
  chipTone: 'upcoming' as const,
}

Deno.test('renderDigestEmail: a section with zero items is not rendered', () => {
  const rendered = renderDigestEmail({
    greetingName: 'Tim',
    sections: [
      section({ tripName: 'Sailing Sicily', actionRows: [sampleRow] }),
      section({ tripName: 'Japan 2026' }), // empty -- must vanish
    ],
    appUrl: APP_URL,
  })
  assert(rendered.html.includes('Sailing Sicily'))
  assert(!rendered.html.includes('Japan 2026'))
  assert(!rendered.text.includes('Japan 2026'))
  // Footer must not claim the email is about the dropped trip either.
  assert(!rendered.html.includes('Japan'))
  assertEquals(rendered.itemCount, 1)
})

Deno.test('renderDigestEmail: all-empty input reports itemCount 0 (caller must not send)', () => {
  const rendered = renderDigestEmail({
    greetingName: 'Tim',
    sections: [section({ tripName: 'Japan 2026' }), section({ tripName: 'test4' })],
    appUrl: APP_URL,
  })
  assertEquals(rendered.itemCount, 0)
  assert(!rendered.html.includes('Japan 2026'))
  assert(!rendered.html.includes('test4'))
})

Deno.test('renderDigestEmail: itemCount counts actions plus other lines after filtering', () => {
  const rendered = renderDigestEmail({
    greetingName: 'Tim',
    sections: [
      section({
        tripName: 'Sailing Sicily',
        actionRows: [sampleRow, { ...sampleRow, title: 'Check in online' }],
        otherLines: [{ description: 'Vote on dinner', link: `${APP_URL}/t` }],
      }),
      section({ tripName: 'Empty trip' }),
    ],
    appUrl: APP_URL,
  })
  assertEquals(rendered.itemCount, 3)
  assertEquals(rendered.subject, 'Sailing Sicily: 3 to-dos are waiting on you')
})

Deno.test('renderDigestEmail: single-action subject still works after filtering empties', () => {
  const rendered = renderDigestEmail({
    greetingName: 'Tim',
    sections: [section({ tripName: 'Empty trip' }), section({ tripName: 'Sailing Sicily', actionRows: [sampleRow] })],
    appUrl: APP_URL,
  })
  // With the empty section dropped only ONE section remains, so the
  // specific single-action subject line applies.
  assertEquals(rendered.subject, 'Sailing Sicily: "Book the ferry" is due in 6 days')
})

Deno.test('renderDigestEmail: action rows and footer carry their exact deep links (html and text)', () => {
  const rendered = renderDigestEmail({
    greetingName: 'Tim',
    sections: [
      section({
        tripName: 'Sailing Sicily',
        actionRows: [{ ...sampleRow, link: `${APP_URL}/t?open=todo:a1` }],
        otherLines: [{ description: 'Answer "Where to stay"', link: `${APP_URL}/t?open=question:s1` }],
        todosLink: `${APP_URL}/t?open=todos`,
      }),
    ],
    appUrl: APP_URL,
  })
  assert(rendered.html.includes('href="https://trips.fontem.ai/t?open=todo:a1"'))
  assert(rendered.html.includes('href="https://trips.fontem.ai/t?open=question:s1"'))
  assert(rendered.html.includes('href="https://trips.fontem.ai/t?open=todos"'))
  assert(rendered.html.includes('See all your to-dos'))
  assert(rendered.text.includes('https://trips.fontem.ai/t?open=todo:a1'))
  assert(rendered.text.includes('See all your to-dos: https://trips.fontem.ai/t?open=todos'))
  assert(!rendered.subject.includes('attention'))
  assert(!rendered.html.includes('things on your trips'))
})

Deno.test('renderDigestEmail: rows without links and sections without todosLink render as before', () => {
  const rendered = renderDigestEmail({ greetingName: 'Tim', sections: [section({ actionRows: [sampleRow] })], appUrl: APP_URL })
  assert(!rendered.html.includes('See all your to-dos'))
  assert(rendered.html.includes('Book the ferry'))
})

Deno.test('renderDigestEmail: decisions-only email is "we have an answer", not a to-do email', () => {
  const rendered = renderDigestEmail({
    greetingName: 'Tim',
    sections: [
      section({
        tripName: 'Japow 2027',
        decisions: [{ headline: '"Where to stay" \u2014 it\'s Hotel Kumo', details: ['\u00a3120 per person', 'Sam is booking it'], link: `${APP_URL}/t?open=question:s1` }],
        todosLink: `${APP_URL}/t?open=todos`,
      }),
    ],
    appUrl: APP_URL,
  })
  assertEquals(rendered.itemCount, 1)
  assertEquals(rendered.subject, 'Japow 2027: we have an answer. "Where to stay" \u2014 it\'s Hotel Kumo')
  assert(rendered.html.includes('We have an answer'))
  assert(rendered.html.includes('Sam is booking it'))
  assert(rendered.html.includes(`${APP_URL}/t?open=question:s1`))
  assert(rendered.text.includes(`${APP_URL}/t?open=question:s1`))
  assert(!rendered.html.includes('to-dos are waiting')) // no to-do wording or footer
  assert(!rendered.html.includes('See all your to-dos'))
})

Deno.test('renderDigestEmail: decisions fold into a to-do digest without changing its subject or count', () => {
  const base = section({ tripName: 'Japow 2027', actionRows: [sampleRow] })
  const without = renderDigestEmail({ greetingName: 'Tim', sections: [base], appUrl: APP_URL })
  const withDecision = renderDigestEmail({
    greetingName: 'Tim',
    sections: [{ ...base, decisions: [{ headline: '"Dinner" \u2014 it\'s Ramen', details: [], link: `${APP_URL}/t?open=question:s2` }] }],
    appUrl: APP_URL,
  })
  assertEquals(withDecision.subject, without.subject)
  assertEquals(withDecision.itemCount, 2)
  assert(withDecision.html.includes('A few to-dos are waiting on you'))
  assert(withDecision.html.includes("it&#39;s Ramen") || withDecision.html.includes("it's Ramen"))
})

Deno.test('renderDigestEmail: no decisions -> output identical to before (to-do digests unchanged)', () => {
  const r = renderDigestEmail({ greetingName: 'Tim', sections: [section({ tripName: 'T', actionRows: [sampleRow] })], appUrl: APP_URL })
  assert(!r.html.includes('We have an answer'))
  assert(r.html.includes('A few to-dos are waiting on you'))
})

import { renderSecondaryButton } from './emailTemplate.ts'
Deno.test('renderSecondaryButton: outlined link, label and url escaped', () => {
  const h = renderSecondaryButton('No <b>', 'https://x.y/?a=1&b="2"')
  assert(h.includes('border:1px solid'))
  assert(h.includes('No &lt;b&gt;'))
  assert(h.includes('href="https://x.y/?a=1&amp;b=&quot;2&quot;"'))
  assert(!h.includes('<b>'))
})
