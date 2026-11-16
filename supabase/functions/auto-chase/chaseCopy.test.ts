import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  humanDay,
  humanDayTime,
  answerDescription,
  claimDescription,
  conditionalDateDescription,
  confirmPaymentDescription,
  payDescription,
  rsvpDescription,
  travelDescription,
  waitlistOfferDescription,
} from './chaseCopy.ts'

const D = '2026-11-17T10:00:00Z'

Deno.test('wording uses the approved vocabulary (question / answer / to-do / Are you coming?)', () => {
  assertEquals(answerDescription('Where to stay', false, D), 'Answer the question "Where to stay" before Tue 17 Nov')
  assertEquals(answerDescription('Ski rental', true, D), 'Choose your own for "Ski rental" before Tue 17 Nov')
  assertStringIncludes(rsvpDescription('Japow 2027', D), 'Are you coming to Japow 2027?')
  assertStringIncludes(conditionalDateDescription('Japow 2027', '2026-11-16'), 'Are you coming to Japow 2027?')
  assertStringIncludes(waitlistOfferDescription('Japow 2027', D), 'A spot opened up on Japow 2027')
  assertEquals(claimDescription('Dinner at Kumo', 86, 'GBP'), 'Claim your items on Dinner at Kumo (£86)')
  assertEquals(payDescription('Japow', 120, 'GBP'), 'Pay £120 to settle up for "Japow"')
  assertEquals(payDescription('Japow', 120, 'GBP', 'Tim'), 'Pay Tim £120 to settle up for "Japow"')
  assertEquals(confirmPaymentDescription('Japow', 42.5, 'GBP'), 'Confirm you received £42.50 for "Japow"')
  assertEquals(confirmPaymentDescription('Japow', 42.5, 'GBP', 'Sam'), 'Confirm Sam paid you £42.50 for "Japow"')
  assertStringIncludes(travelDescription('Japow'), 'Add your flights or travel times')
})

Deno.test('no retired words in any email line', () => {
  const all = [
    answerDescription('Q', false, D),
    answerDescription('Q', true, D),
    rsvpDescription('T', D),
    conditionalDateDescription('T', '2026-11-16'),
    waitlistOfferDescription('T', D),
    claimDescription('X', 1, 'GBP'),
    payDescription('T', 1, 'GBP'),
    confirmPaymentDescription('T', 1, 'GBP'),
    travelDescription('T'),
  ].join('\n')
  for (const word of [/\bvote\b/i, /\bpoll\b/i, /\baction\b/i, /\bblocker/i, /unvoted/i]) {
    assertEquals(word.test(all), false, String(word))
  }
})

Deno.test('deadlines read like people say them, in UTC, never a raw UTC string', () => {
  assertEquals(humanDay('2026-12-11T23:30:00Z'), 'Fri 11 Dec')
  assertEquals(humanDay('2026-12-12T00:30:00Z'), 'Sat 12 Dec')
  assertEquals(humanDayTime('2026-12-12T14:05:00Z'), 'Sat 12 Dec, 14:05 UTC')
  assertStringIncludes(rsvpDescription('Japow', '2026-12-12T09:00:00Z'), 'Please reply before Sat 12 Dec.')
  assertStringIncludes(waitlistOfferDescription('Japow', '2026-12-12T14:05:00Z'), 'Respond before Sat 12 Dec, 14:05 UTC or')
  for (const line of [answerDescription('Q', true, D), rsvpDescription('T', D), waitlistOfferDescription('T', D)]) {
    assertEquals(/GMT|:00 /.test(line.replace(/\d\d:\d\d UTC/, '')), false, line)
  }
})
