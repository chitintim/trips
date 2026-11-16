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
  renderReAskNotice,
  renderRetractedNotice,
  confirmPageUrl,
  countAfter,
  latestIso,
  decidePaidSequence,
  decideReAsk,
  decideRetractedSequence,
  decideDisputedRound,
  retractedNoticeKey,
  mayRequestDisputedNotice,
  mayRequestReAsk,
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
  confirmYesUrl: 'https://trips.fontem.ai/confirm-payment?t=TOK&a=yes',
  confirmNoUrl: 'https://trips.fontem.ai/confirm-payment?t=TOK&a=no',
  appUrl: 'https://trips.fontem.ai/trip1?open=payment:s1',
}

Deno.test('paid email: subject, plain wording, both links, footer, no note line', () => {
  const m = renderPaidNotice(paid)
  assertEquals(m.subject, 'Salim paid you £105.11 — Japow')
  assertStringIncludes(m.html, 'Salim says they paid you £105.11 for Japow.')
  assertStringIncludes(m.html, 'Yes, I received it')
  assertStringIncludes(m.html, "I haven't received it")
  assertStringIncludes(m.html, 'href="https://trips.fontem.ai/confirm-payment?t=TOK&amp;a=yes"')
  assertStringIncludes(m.html, 'href="https://trips.fontem.ai/confirm-payment?t=TOK&amp;a=no"')
  assertStringIncludes(m.html, 'href="https://trips.fontem.ai/trip1?open=payment:s1"')
  assertStringIncludes(m.html, 'Email notifications')
  assertFalse(m.html.includes('note'))
  assertStringIncludes(m.text, 'Yes, I received it: https://trips.fontem.ai/confirm-payment?t=TOK&a=yes')
  assertStringIncludes(m.text, "I haven't received it: https://trips.fontem.ai/confirm-payment?t=TOK&a=no")
  assertEquals(m.subject.includes('\n'), false)
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

// ---------------------------------------------------------------------------
// Dispute / re-ask / retract (pure rules)
// ---------------------------------------------------------------------------

Deno.test('confirmPageUrl: answer hint is optional and encoded', () => {
  assertEquals(confirmPageUrl('https://x.y', 'ab-_'), 'https://x.y/confirm-payment?t=ab-_')
  assertEquals(confirmPageUrl('https://x.y', 'ab-_', 'yes'), 'https://x.y/confirm-payment?t=ab-_&a=yes')
  assertEquals(confirmPageUrl('https://x.y', 'ab-_', 'no'), 'https://x.y/confirm-payment?t=ab-_&a=no')
})

Deno.test('keys: first notice keeps the old key, later ones count up', () => {
  assertEquals(paidNoticeKey('s', 'r'), 'notice:paid:s:r:1')
  assertEquals(paidNoticeKey('s', 'r', 3), 'notice:paid:s:r:3')
  assertEquals(disputedNoticeKey('s', 'p'), 'notice:disputed:s:p:1')
  assertEquals(disputedNoticeKey('s', 'p', 2), 'notice:disputed:s:p:2')
  assertEquals(retractedNoticeKey('s', 'r', 2), 'notice:retracted:s:r:2')
})

const T = (n: number) => new Date(Date.UTC(2026, 10, 20, 0, n)).toISOString()

Deno.test('time helpers', () => {
  assertEquals(latestIso([]), null)
  assertEquals(latestIso([T(2), null, T(5), T(1)]), T(5))
  assertEquals(countAfter([T(1), T(2), T(3)], null), 3)
  assertEquals(countAfter([T(1), T(2), T(3)], T(2)), 1)
})

Deno.test('paid sequence: once per round, a new round after a retraction, hard cap of 4', () => {
  assertEquals(decidePaidSequence({ paidTypeTimes: [], lastRetractAt: null }), { send: true, n: 1 })
  assertEquals(decidePaidSequence({ paidTypeTimes: [T(1)], lastRetractAt: null }), { send: false, reason: 'already_sent' })
  // a re-ask in the same round also counts as "already told"
  assertEquals(decidePaidSequence({ paidTypeTimes: [T(1), T(3)], lastRetractAt: null }), { send: false, reason: 'already_sent' })
  // retracted after the first notice: the next marking is a new round, sequence number 2
  assertEquals(decidePaidSequence({ paidTypeTimes: [T(1)], lastRetractAt: T(2) }), { send: true, n: 2 })
  assertEquals(decidePaidSequence({ paidTypeTimes: [T(1), T(3)], lastRetractAt: T(4) }), { send: true, n: 3 })
  assertEquals(decidePaidSequence({ paidTypeTimes: [T(1), T(3), T(5)], lastRetractAt: T(6) }), { send: true, n: 4 })
  assertEquals(decidePaidSequence({ paidTypeTimes: [T(1), T(3), T(5), T(7)], lastRetractAt: T(8) }), { send: false, reason: 'capped' })
})

Deno.test('re-ask rules: marked paid, currently disputed, max 2 ever, sequence number shared with paid', () => {
  const ok = { status: 'marked_paid', disputed: true, payerId: 'p', receiverId: 'r', reAsksUsed: 0, paidTypeCount: 1 }
  assertEquals(decideReAsk(ok), { allowed: true, n: 2 })
  assertEquals(decideReAsk({ ...ok, reAsksUsed: 1, paidTypeCount: 2 }), { allowed: true, n: 3 })
  assertEquals(decideReAsk({ ...ok, reAsksUsed: 2, paidTypeCount: 3 }), { allowed: false, reason: 'reask_limit' })
  assertEquals(decideReAsk({ ...ok, status: 'suggested' }), { allowed: false, reason: 'not_marked_paid' })
  assertEquals(decideReAsk({ ...ok, status: 'confirmed' }), { allowed: false, reason: 'not_marked_paid' })
  assertEquals(decideReAsk({ ...ok, disputed: false }), { allowed: false, reason: 'not_disputed' })
  assertEquals(decideReAsk({ ...ok, receiverId: 'p' }), { allowed: false, reason: 'same_person' })
  // sequence full: allowed (the flag is still cleared) but no email number
  assertEquals(decideReAsk({ ...ok, paidTypeCount: 4 }), { allowed: true, n: null })
})

Deno.test('retracted rules: server stamp required and recent, only at suggested, only if the receiver was told, once per retraction, max 4', () => {
  const now = new Date(T(10))
  const r = { status: 'suggested', paidTypeTimes: [T(1)], retractedTimes: [] as string[], lastRetractedAt: T(8), now }
  assertEquals(decideRetractedSequence(r), { send: true, n: 1 })
  assertEquals(decideRetractedSequence({ ...r, status: 'marked_paid' }), { send: false, reason: 'not_suggested' })
  assertEquals(decideRetractedSequence({ ...r, paidTypeTimes: [] }), { send: false, reason: 'never_notified' })
  // no stamp from the database (never retracted, or the column is missing): nothing is sent
  assertEquals(decideRetractedSequence({ ...r, lastRetractedAt: null }), { send: false, reason: 'not_retracted' })
  // a stamp from long ago cannot be used to send a mail now
  assertEquals(decideRetractedSequence({ ...r, lastRetractedAt: T(8), now: new Date(T(8 + 31)) }), { send: false, reason: 'retract_stale' })
  assertEquals(decideRetractedSequence({ ...r, lastRetractedAt: T(8), now: new Date(T(8 + 29)) }), { send: true, n: 1 })
  // a retracted mail already went out for THIS retraction
  assertEquals(decideRetractedSequence({ ...r, retractedTimes: [T(9)] }), { send: false, reason: 'already_sent' })
  // mail for an EARLIER retraction does not block this one: marked paid again (T3), retracted again (T8): key 2
  assertEquals(decideRetractedSequence({ ...r, paidTypeTimes: [T(1), T(3)], retractedTimes: [T(2)] }), { send: true, n: 2 })
  assertEquals(decideRetractedSequence({ ...r, paidTypeTimes: [T(1), T(3), T(5), T(7)], retractedTimes: [T(2), T(4), T(6), T(7)] }), { send: false, reason: 'capped' })
})

Deno.test('disputed rounds: one per round, new round after each paid / re-ask notice, cap 6', () => {
  assertEquals(decideDisputedRound({ disputedTimes: [], paidTypeTimes: [T(1)] }), { send: true, n: 1 })
  assertEquals(decideDisputedRound({ disputedTimes: [T(2)], paidTypeTimes: [T(1)] }), { send: false, reason: 'already_sent' })
  assertEquals(decideDisputedRound({ disputedTimes: [T(2)], paidTypeTimes: [T(1), T(3)] }), { send: true, n: 2 })
  assertEquals(decideDisputedRound({ disputedTimes: [T(2)], paidTypeTimes: [] }), { send: false, reason: 'already_sent' })
  const six = [T(2), T(4), T(6), T(8), T(10), T(12)]
  assertEquals(decideDisputedRound({ disputedTimes: six, paidTypeTimes: [T(1), T(3), T(5), T(7), T(9), T(11), T(13)] }), { send: false, reason: 'capped' })
})

Deno.test('who may ask: re-ask and retract = payer or manager; in-app dispute = the receiver only', () => {
  assert(mayRequestReAsk({ callerId: 'p', payerId: 'p', canManage: false }))
  assert(mayRequestReAsk({ callerId: 'o', payerId: 'p', canManage: true }))
  assertFalse(mayRequestReAsk({ callerId: 'r', payerId: 'p', canManage: false }))
  assert(mayRequestDisputedNotice({ callerId: 'r', receiverId: 'r' }))
  assertFalse(mayRequestDisputedNotice({ callerId: 'p', receiverId: 'r' }))
})

Deno.test('re-ask email: two links, wording, escaping', () => {
  const m = renderReAskNotice({ ...paid, payerName: 'Sal<im>' })
  assertEquals(m.subject, "Sal<im> says they've sent £105.11 — can you check again?")
  assertStringIncludes(m.html, 'Sal&lt;im&gt; says they&#39;ve sent'.replace('&#39;', "'"))
  assertStringIncludes(m.text, "can you check again?")
  assertStringIncludes(m.text, 'a=yes')
  assertStringIncludes(m.text, 'a=no')
  assertStringIncludes(m.html, 'a=no')
  assertFalse(m.html.includes('Sal<im>'))
  assertFalse(/[\r\n]/.test(renderReAskNotice({ ...paid, payerName: 'A\r\nB' }).subject))
})

Deno.test('retracted email: one line, no token, links to the trip', () => {
  const m = renderRetractedNotice({ receiverFirstName: 'Tim', payerName: 'Salim', amount: 105.11, currency: 'GBP', tripName: 'Japow', tripUrl: 'https://trips.fontem.ai/t1' })
  assertEquals(m.subject, "Salim hasn't paid the £105.11 yet — Japow")
  assertStringIncludes(m.text, "Salim hasn't paid the £105.11 yet — they'll mark it paid when they have.")
  assertFalse(m.text.includes('confirm-payment'))
  assertStringIncludes(m.html, 'href="https://trips.fontem.ai/t1"')
  const evil = renderRetractedNotice({ receiverFirstName: '<b>', payerName: '<i>', amount: 1, currency: 'GBP', tripName: '<u>', tripUrl: 'https://x.y' })
  assertFalse(evil.html.includes('<i>'))
  assertFalse(evil.html.includes('<b>'))
})

Deno.test('mapTokenState: states after a "No"', () => {
  const used = { ...tok, used_at: '2026-11-20T02:00:00Z', used_action: 'disputed' }
  const disputed = { ...sett, receipt_disputed_at: '2026-11-20T01:00:00Z' }
  const asked = { ...sett, receipt_disputed_at: null }
  assertEquals(mapTokenState({ token: used, settlement: disputed, now }), 'disputed')
  assertEquals(mapTokenState({ token: used, settlement: asked, now, newerToken: true }), 'asked_again')
  // no newer link and the flag is gone: someone changed it and we cannot tell how -> neutral "changed"
  assertEquals(mapTokenState({ token: used, settlement: asked, now, newerToken: false }), 'changed')
  // D8: taken back and marked paid again AFTER this link was used is a new round, never "asked again"
  const reRound = { ...asked, last_retracted_at: '2026-11-20T03:00:00Z' }
  assertEquals(mapTokenState({ token: used, settlement: reRound, now, newerToken: true }), 'expired')
  // ... but a retraction BEFORE the link was used does not matter
  assertEquals(mapTokenState({ token: used, settlement: { ...asked, last_retracted_at: '2026-11-20T01:00:00Z' }, now, newerToken: true }), 'asked_again')
  // the column does not exist (undefined): old behaviour
  assertEquals(mapTokenState({ token: used, settlement: sett, now }), 'disputed')
  assertEquals(mapTokenState({ token: used, settlement: { ...sett, status: 'suggested', receipt_disputed_at: null }, now }), 'retracted')
  assertEquals(mapTokenState({ token: { ...used, used_action: 'superseded' }, settlement: { ...sett, status: 'suggested' }, now }), 'retracted')
  assertEquals(mapTokenState({ token: used, settlement: { ...sett, status: 'confirmed', receipt_disputed_at: null }, now }), 'confirmed')
  // an older, superseded token while the payment is disputed shows the truth; not disputed = expired
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'superseded' }, settlement: disputed, now }), 'disputed')
  assertEquals(mapTokenState({ token: { ...tok, used_at: 'x', used_action: 'superseded' }, settlement: asked, now, newerToken: true }), 'expired')
  // an unused token on a retracted payment is simply "changed" (the trigger retires tokens, so this is rare)
  assertEquals(mapTokenState({ token: tok, settlement: { ...sett, status: 'suggested' }, now }), 'changed')
  // an unused token stays valid while disputed in the app (the receiver may still confirm)
  assertEquals(mapTokenState({ token: tok, settlement: disputed, now }), 'valid')
  assertEquals(mapTokenState({ token: { ...used, used_action: 'confirmed' }, settlement: disputed, now }), 'confirmed')
})
