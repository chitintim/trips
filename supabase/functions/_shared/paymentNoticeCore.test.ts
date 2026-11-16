import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1'
import {
  allowedOrigins,
  canManageTripFacts,
  clientIp,
  confirmedNoticeKey,
  decideConfirmedNotice,
  decideDisputedNotice,
  decidePaidNotice,
  disputedNoticeKey,
  displayFirstName,
  isAllowedOrigin,
  isPayerSquare,
  mapRpcResult,
  mapTokenState,
  mayRequestConfirmedNotice,
  mayRequestPaidNotice,
  oneLine,
  overDailyCap,
  paidNoticeKey,
  renderDisputedNotice,
  renderConfirmedNotice,
  renderPaidNotice,
  trimNote,
  type TokenFacts,
} from './paymentNoticeCore.ts'

const OK_RECIPIENT = { email: 'a@b.co', emailNotificationsEnabled: true, channelAvailable: true }
const base = { status: 'marked_paid', payerId: 'payer', receiverId: 'recv', callerId: 'payer', receiver: OK_RECIPIENT }

Deno.test('dedupe keys have the agreed format', () => {
  assertEquals(paidNoticeKey('s1', 'r1'), 'notice:paid:s1:r1:1')
  assertEquals(confirmedNoticeKey('s1', 'p1'), 'notice:confirmed:s1:p1:1')
})

Deno.test('paid notice gates: sends for a marked_paid payment to a reachable receiver', () => {
  assertEquals(decidePaidNotice(base), { send: true, reason: null })
})

Deno.test('paid notice gates: each blocker', () => {
  assertEquals(decidePaidNotice({ ...base, status: 'confirmed' }).reason, 'not_marked_paid')
  assertEquals(decidePaidNotice({ ...base, status: 'suggested' }).reason, 'not_marked_paid')
  assertEquals(decidePaidNotice({ ...base, receiverId: 'payer' }).reason, 'same_person')
  assertEquals(decidePaidNotice({ ...base, callerId: 'recv' }).reason, 'self_recorded')
  assertEquals(decidePaidNotice({ ...base, receiver: { ...OK_RECIPIENT, emailNotificationsEnabled: false } }).reason, 'opt_out')
  assertEquals(decidePaidNotice({ ...base, receiver: { ...OK_RECIPIENT, email: null } }).reason, 'no_email')
  assertEquals(decidePaidNotice({ ...base, receiver: { ...OK_RECIPIENT, email: '  ' } }).reason, 'no_email')
  assertEquals(decidePaidNotice({ ...base, receiver: { ...OK_RECIPIENT, channelAvailable: false } }).reason, 'no_channel')
})

Deno.test('paid notice gates: a null master switch is not an opt-out (column default is true)', () => {
  assert(decidePaidNotice({ ...base, receiver: { ...OK_RECIPIENT, emailNotificationsEnabled: null } }).send)
})

Deno.test('confirmed notice gates', () => {
  const c = { status: 'confirmed', payerId: 'payer', receiverId: 'recv', payer: OK_RECIPIENT }
  assert(decideConfirmedNotice(c).send)
  assertEquals(decideConfirmedNotice({ ...c, status: 'marked_paid' }).reason, 'not_confirmed')
  assertEquals(decideConfirmedNotice({ ...c, receiverId: 'payer' }).reason, 'same_person')
  assertEquals(decideConfirmedNotice({ ...c, payer: { ...OK_RECIPIENT, emailNotificationsEnabled: false } }).reason, 'opt_out')
  assertEquals(decideConfirmedNotice({ ...c, payer: { ...OK_RECIPIENT, email: null } }).reason, 'no_email')
})

Deno.test('who may request: paid = payer or manager; confirmed = receiver only', () => {
  assert(mayRequestPaidNotice({ callerId: 'p', payerId: 'p', canManage: false }))
  assert(mayRequestPaidNotice({ callerId: 'o', payerId: 'p', canManage: true }))
  assertFalse(mayRequestPaidNotice({ callerId: 'x', payerId: 'p', canManage: false }))
  assert(mayRequestConfirmedNotice({ callerId: 'r', receiverId: 'r' }))
  assertFalse(mayRequestConfirmedNotice({ callerId: 'o', receiverId: 'r' }))
  assertFalse(mayRequestConfirmedNotice({ callerId: 'p', receiverId: 'r' }))
})

Deno.test('canManageTripFacts: admin, ACTIVE organiser or creator', () => {
  assert(canManageTripFacts({ isSiteAdmin: true, isActiveOrganizer: false, isTripCreator: false }))
  assert(canManageTripFacts({ isSiteAdmin: false, isActiveOrganizer: true, isTripCreator: false }))
  assert(canManageTripFacts({ isSiteAdmin: false, isActiveOrganizer: false, isTripCreator: true }))
  assertFalse(canManageTripFacts({ isSiteAdmin: false, isActiveOrganizer: false, isTripCreator: false }))
})

Deno.test('isPayerSquare needs a frozen trip, no other unfinished payment and no carryover; unknown is not square', () => {
  assert(isPayerSquare({ tripFrozen: true, otherUnfinishedPaymentsByPayer: 0, carryoversInvolvingPayer: 0 }))
  assertFalse(isPayerSquare({ tripFrozen: true, otherUnfinishedPaymentsByPayer: 1, carryoversInvolvingPayer: 0 }))
  assertFalse(isPayerSquare({ tripFrozen: true, otherUnfinishedPaymentsByPayer: 0, carryoversInvolvingPayer: 1 }))
  assertFalse(isPayerSquare({ tripFrozen: false, otherUnfinishedPaymentsByPayer: 0, carryoversInvolvingPayer: 0 }))
  assertFalse(isPayerSquare({ tripFrozen: true, otherUnfinishedPaymentsByPayer: null, carryoversInvolvingPayer: 0 }))
  assertFalse(isPayerSquare({ tripFrozen: true, otherUnfinishedPaymentsByPayer: 0, carryoversInvolvingPayer: null }))
})

Deno.test('names and text hygiene', () => {
  assertEquals(displayFirstName({ first_name: ' Salim ', full_name: 'Salim Khan' }), 'Salim')
  assertEquals(displayFirstName({ first_name: null, full_name: 'Salim Khan' }), 'Salim')
  assertEquals(displayFirstName(null), 'Someone')
  assertEquals(oneLine('a\r\nBcc: x@y.z'), 'a Bcc: x@y.z')
  assertEquals(trimNote('   '), null)
  assertEquals(trimNote(null), null)
  assertEquals(trimNote('a\n b'), 'a b')
  assertEquals(trimNote('x'.repeat(400))!.length, 300)
})

const paid = {
  receiverFirstName: 'Tim',
  payerName: 'Salim',
  recordedByName: null,
  amount: 105.11,
  currency: 'GBP',
  tripName: 'Japow',
  note: null,
  confirmUrl: 'https://trips.fontem.ai/confirm-payment?t=TOK',
  appUrl: 'https://trips.fontem.ai/trip1?open=payment:s1',
}

Deno.test('paid email: subject, plain wording, both links, footer, no note line', () => {
  const m = renderPaidNotice(paid)
  assertEquals(m.subject, 'Salim paid you £105.11 — Japow')
  assertStringIncludes(m.html, 'Salim says they paid you £105.11 for Japow.')
  assertStringIncludes(m.html, 'Yes, I received it')
  assertStringIncludes(m.html, 'href="https://trips.fontem.ai/confirm-payment?t=TOK"')
  assertStringIncludes(m.html, 'href="https://trips.fontem.ai/trip1?open=payment:s1"')
  assertStringIncludes(m.html, 'Email notifications')
  assertFalse(m.html.includes('note'))
  assertStringIncludes(m.text, 'Yes, I received it: https://trips.fontem.ai/confirm-payment?t=TOK')
  assertStringIncludes(m.text, 'Email notifications')
  assertFalse(m.text.includes('note'))
})

Deno.test('paid email recorded by an organiser says so truthfully', () => {
  const m = renderPaidNotice({ ...paid, recordedByName: 'Tim', receiverFirstName: 'Amy' })
  assertStringIncludes(m.html, 'Tim recorded that Salim paid you £105.11 for Japow.')
  assertStringIncludes(m.text, 'Tim recorded that Salim paid you £105.11 for Japow.')
  assertFalse(m.html.includes('says they paid you'))
  assertEquals(m.subject, 'Salim paid you £105.11 — Japow')
})

Deno.test('paid email escapes names, trip and note (user-entered text)', () => {
  const evil = '<img src=x onerror=alert(1)>"&'
  const m = renderPaidNotice({ ...paid, payerName: evil, tripName: evil, receiverFirstName: evil, note: evil, recordedByName: evil })
  assertFalse(m.html.includes('<img'))
  assertStringIncludes(m.html, '&lt;img src=x onerror=alert(1)&gt;')
  assertStringIncludes(m.html, '&quot;')
  // The plain-text part is not HTML, so it carries the text as typed.
  assertStringIncludes(m.text, evil)
})

Deno.test('paid email shows the payer note only when there is one, escaped and trimmed', () => {
  const m = renderPaidNotice({ ...paid, note: '  Cash  <b>at lunch</b>  ' })
  assertStringIncludes(m.html, "Salim's note")
  assertStringIncludes(m.html, 'Cash &lt;b&gt;at lunch&lt;/b&gt;')
  assertStringIncludes(m.text, `Salim's note: "Cash <b>at lunch</b>"`)
})

Deno.test('paid email subject cannot carry a header break', () => {
  const m = renderPaidNotice({ ...paid, tripName: 'Japow\r\nBcc: evil@x.y' })
  assertFalse(/[\r\n]/.test(m.subject))
})

Deno.test('confirmed email: square vs not', () => {
  const c = { payerFirstName: 'Salim', receiverName: 'Tim', amount: 105.11, currency: 'GBP', tripName: 'Japow', square: true, tripUrl: 'https://trips.fontem.ai/trip1' }
  const sq = renderConfirmedNotice(c)
  assertEquals(sq.subject, 'Tim confirmed your £105.11 — Japow')
  assertStringIncludes(sq.html, "Tim confirmed your £105.11 — you're square for Japow.")
  const ns = renderConfirmedNotice({ ...c, square: false })
  assertStringIncludes(ns.html, 'Tim confirmed your £105.11 for Japow.')
  assertFalse(ns.html.includes('square'))
  assertStringIncludes(ns.text, 'https://trips.fontem.ai/trip1')
})

const tok: TokenFacts = { receiver_id: 'r', amount: 10, currency: 'GBP', expires_at: '2026-12-01T00:00:00Z', used_at: null, used_action: null }
const sett = { status: 'marked_paid', to_user_id: 'r', amount: 10, currency: 'GBP' }
const now = new Date('2026-11-20T00:00:00Z')

Deno.test('mapTokenState', () => {
  assertEquals(mapTokenState({ token: tok, settlement: sett, now }), 'valid')
  assertEquals(mapTokenState({ token: null, settlement: sett, now }), 'invalid')
  assertEquals(mapTokenState({ token: { ...tok, expires_at: '2026-11-19T00:00:00Z' }, settlement: sett, now }), 'expired')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'confirmed' }, settlement: sett, now }), 'confirmed')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'disputed' }, settlement: sett, now }), 'disputed')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'superseded' }, settlement: sett, now }), 'expired')
  assertEquals(mapTokenState({ token: tok, settlement: null, now }), 'changed')
  assertEquals(mapTokenState({ token: tok, settlement: { ...sett, status: 'confirmed' }, now }), 'confirmed')
  assertEquals(mapTokenState({ token: tok, settlement: { ...sett, status: 'suggested' }, now }), 'changed')
  assertEquals(mapTokenState({ token: tok, settlement: { ...sett, amount: 11 }, now }), 'changed')
  assertEquals(mapTokenState({ token: tok, settlement: { ...sett, currency: 'EUR' }, now }), 'changed')
  assertEquals(mapTokenState({ token: tok, settlement: { ...sett, to_user_id: 'other' }, now }), 'changed')
  assertEquals(mapTokenState({ token: { ...tok, amount: 105.11 }, settlement: { ...sett, amount: 105.11 }, now }), 'valid')
})

Deno.test('mapRpcResult', () => {
  assertEquals(mapRpcResult('confirmed', null), 'confirmed')
  assertEquals(mapRpcResult('already_confirmed', null), 'confirmed')
  assertEquals(mapRpcResult('disputed', null), 'disputed')
  assertEquals(mapRpcResult('used', 'confirmed'), 'confirmed')
  assertEquals(mapRpcResult('used', 'disputed'), 'disputed')
  assertEquals(mapRpcResult('used', 'superseded'), 'expired')
  assertEquals(mapRpcResult('expired', null), 'expired')
  assertEquals(mapRpcResult('changed', null), 'changed')
  assertEquals(mapRpcResult('not_found', null), 'invalid')
  assertEquals(mapRpcResult(undefined, null), 'invalid')
})

Deno.test('CORS origin check: only the app origin(s)', () => {
  const allowed = allowedOrigins('https://trips.fontem.ai/', 'https://staging.example.com, not a url, http://evil.example')
  assertEquals(allowed, ['https://trips.fontem.ai', 'https://staging.example.com'])
  assert(isAllowedOrigin('https://trips.fontem.ai', allowed))
  assertFalse(isAllowedOrigin('https://trips.fontem.ai.evil.com', allowed))
  assertFalse(isAllowedOrigin('http://trips.fontem.ai', allowed))
  assertFalse(isAllowedOrigin(null, allowed))
  assertFalse(isAllowedOrigin('null', allowed))
  assertFalse(isAllowedOrigin('*', allowed))
})

Deno.test('clientIp takes the first forwarded address', () => {
  assertEquals(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4')
  assertEquals(clientIp(new Headers()), 'unknown')
})

Deno.test('disputed notice: key, gates, cap', () => {
  assertEquals(disputedNoticeKey('s1', 'p1'), 'notice:disputed:s1:p1:1')
  const d = { status: 'marked_paid', payerId: 'payer', receiverId: 'recv', payer: OK_RECIPIENT }
  assertEquals(decideDisputedNotice(d), { send: true, reason: null })
  assertEquals(decideDisputedNotice({ ...d, status: 'confirmed' }).reason, 'not_marked_paid')
  assertEquals(decideDisputedNotice({ ...d, payerId: 'recv' }).reason, 'same_person')
  assertEquals(decideDisputedNotice({ ...d, payer: { ...OK_RECIPIENT, emailNotificationsEnabled: false } }).reason, 'opt_out')
  assertEquals(decideDisputedNotice({ ...d, payer: { ...OK_RECIPIENT, email: '' } }).reason, 'no_email')
  assertEquals(decideDisputedNotice({ ...d, payer: { ...OK_RECIPIENT, channelAvailable: false } }).reason, 'no_channel')
  assertFalse(overDailyCap(9))
  assert(overDailyCap(10))
  assert(overDailyCap(null)) // unknown count = fail closed
})

Deno.test('disputed email: says it plainly, escapes, single-line subject', () => {
  const m = renderDisputedNotice({ payerFirstName: 'Salim', receiverName: 'Tim <b>', amount: 105.11, currency: 'GBP', tripName: 'Japow', tripUrl: 'https://trips.fontem.ai/t1' })
  assertEquals(m.subject, "Tim <b> says they haven't received your £105.11 yet")
  assertStringIncludes(m.text, "Tim <b> says they haven't received your £105.11 yet for Japow.")
  assertStringIncludes(m.html, 'Tim &lt;b&gt;')
  assertFalse(m.html.includes('Tim <b>'))
  assertFalse(/[\r\n]/.test(m.subject))
})

Deno.test('mapTokenState: the link shows the current truth after an in-app confirm (L7)', () => {
  const confirmed = { ...sett, status: 'confirmed' }
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'disputed' }, settlement: confirmed, now }), 'confirmed')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'superseded' }, settlement: confirmed, now }), 'confirmed')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'disputed' }, settlement: sett, now }), 'disputed')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'superseded' }, settlement: sett, now }), 'expired')
})
