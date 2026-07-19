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
  assert(rendered.subject.includes('3 things need your attention'))
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
