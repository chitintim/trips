import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1'
import { allowedOrigins, isAllowedOrigin } from './paymentNoticeCore.ts'
import {
  DONE_LABEL,
  RULE_SENTENCE,
  assignedFingerprint,
  claimEmailSubject,
  decideReceiptNotice,
  decideReminderEngagement,
  decideTableSequence,
  decideReminderSequence,
  decideResultSequence,
  deadlineDay,
  resultKeyAmount,
  REASON_MESSAGES,
  formatDeadline,
  isMissingFunction,
  latestOwnChange,
  mapActResult,
  mapPeekResult,
  mapSendRpcError,
  mayRequestSendToTable,
  overReceiptCap,
  personItems,
  rateKey,
  receiptAppUrl,
  receiptPageUrl,
  renderClaimEmail,
  renderResultEmail,
  reminderNoticeKey,
  resultNoticeKey,
  summariseSendOutcomes,
  tableFingerprintKey,
  tableNoticeKey,
  type ClaimEmailInput,
  type ClaimRow,
  type LineRow,
  type ReceiptFacts,
} from './receiptNoticeCore.ts'

const NOW = new Date('2026-11-17T12:00:00Z')
const OK_RECIPIENT = { email: 'a@b.co', emailNotificationsEnabled: true, channelAvailable: true }
const OPEN: ReceiptFacts = { noticesEnabled: true, frozen: false, claimsSentAt: '2026-11-17T10:00:00Z', claimsClosedAt: null, claimDeadline: '2026-11-20T18:00:00Z' }
const gate = (type: 'table' | 'reminder' | 'result', receipt: Partial<ReceiptFacts> = {}, over: Record<string, unknown> = {}) =>
  decideReceiptNotice({ type, receipt: { ...OPEN, ...receipt }, recipient: OK_RECIPIENT, recipientId: 'u1', actorId: 'payer', now: NOW, ...over })

// --- keys -----------------------------------------------------------------

Deno.test('keys follow notice:receipt:<expense>:<user>:<kind>', () => {
  assertEquals(tableNoticeKey('e', 'u'), 'notice:receipt:e:u:table')
  assertEquals(tableNoticeKey('e', 'u', 1), 'notice:receipt:e:u:table')
  assertEquals(tableNoticeKey('e', 'u', 2), 'notice:receipt:e:u:table:2')
  assertEquals(tableFingerprintKey('e', 'u', 2, 'abc'), 'notice:receipt:e:u:tablefp:2:abc')
  assertEquals(reminderNoticeKey('e', 'u', '2026-11-20T18:00:00Z'), 'notice:receipt:e:u:reminder:2026-11-20')
  assertEquals(resultNoticeKey('e', 'u', 450), 'notice:receipt:e:u:result:450')
})

// --- who may ask ----------------------------------------------------------

Deno.test('mayRequestSendToTable: the payer or a manager, nobody else', () => {
  assert(mayRequestSendToTable({ callerId: 'p', payerId: 'p', canManage: false }))
  assert(mayRequestSendToTable({ callerId: 'o', payerId: 'p', canManage: true }))
  assertFalse(mayRequestSendToTable({ callerId: 'x', payerId: 'p', canManage: false }))
  assertFalse(mayRequestSendToTable({ callerId: 'x', payerId: null, canManage: false }))
  assertFalse(mayRequestSendToTable({ callerId: 'p', payerId: undefined, canManage: true }))
})

// --- gates ----------------------------------------------------------------

Deno.test('gates: an open receipt sends; the caller never gets their own email', () => {
  assertEquals(gate('table'), { send: true, reason: null })
  assertEquals(gate('table', {}, { recipientId: 'payer' }).reason, 'same_person')
  // the daily job has no actor, so the payer can get a reminder / result
  assertEquals(gate('reminder', { claimDeadline: '2026-11-18T10:00:00Z' }, { recipientId: 'payer', actorId: null }).send, true)
})

Deno.test('gates: trip switch, state of the receipt, then the recipient settings', () => {
  assertEquals(gate('table', { noticesEnabled: false }).reason, 'notices_off')
  assertEquals(gate('table', { noticesEnabled: null }).send, true)
  assertEquals(gate('table', { claimsSentAt: null }).reason, 'not_open')
  assertEquals(gate('table', { claimsClosedAt: '2026-11-19T00:00:00Z' }).reason, 'closed')
  assertEquals(gate('table', { frozen: true }).reason, 'frozen')
  assertEquals(gate('table', { claimDeadline: '2026-11-17T11:59:59Z' }).reason, 'closed')
  assertEquals(gate('table', { claimDeadline: null }).send, true)
  assertEquals(gate('table', {}, { recipient: { ...OK_RECIPIENT, emailNotificationsEnabled: false } }).reason, 'opt_out')
  assertEquals(gate('table', {}, { recipient: { ...OK_RECIPIENT, emailNotificationsEnabled: null } }).send, true)
  assertEquals(gate('table', {}, { recipient: { ...OK_RECIPIENT, email: ' ' } }).reason, 'no_email')
  assertEquals(gate('table', {}, { recipient: { ...OK_RECIPIENT, email: null } }).reason, 'no_email')
  assertEquals(gate('table', {}, { recipient: { ...OK_RECIPIENT, channelAvailable: false } }).reason, 'no_channel')
})

Deno.test('gates: the reminder needs a deadline at most 25 hours away', () => {
  assertEquals(gate('reminder', { claimDeadline: '2026-11-18T12:00:00Z' }).send, true) // 24h
  assertEquals(gate('reminder', { claimDeadline: '2026-11-18T13:00:00Z' }).send, true) // 25h, the edge
  assertEquals(gate('reminder', { claimDeadline: '2026-11-18T13:00:01Z' }).reason, 'not_due')
  assertEquals(gate('reminder', { claimDeadline: null }).reason, 'not_due')
  assertEquals(gate('reminder', { claimDeadline: '2026-11-17T11:00:00Z' }).reason, 'closed')
})

Deno.test('gates: the result needs a closed receipt and ignores freeze and the deadline', () => {
  assertEquals(gate('result').reason, 'not_closed')
  const closed = { claimsClosedAt: '2026-11-20T18:05:00Z', frozen: true, claimDeadline: '2026-11-20T18:00:00Z' }
  assertEquals(gate('result', closed, { actorId: null }).send, true)
  assertEquals(gate('result', { ...closed, noticesEnabled: false }, { actorId: null }).reason, 'notices_off')
})

Deno.test('cap: six receipt notices in 24h; an unknown count counts as over', () => {
  assertFalse(overReceiptCap(5))
  assert(overReceiptCap(6))
  assert(overReceiptCap(null))
  assert(overReceiptCap(undefined))
  assertFalse(overReceiptCap(0))
})

// --- table sequence -------------------------------------------------------

Deno.test('table sequence: first always; later only on a change; capped at 3; unknown last state sends nothing', () => {
  assertEquals(decideTableSequence({ priorCount: 0, lastFingerprint: null, fingerprint: 'x' }), { send: true, n: 1 })
  assertEquals(decideTableSequence({ priorCount: 1, lastFingerprint: 'x', fingerprint: 'x' }), { send: false, reason: 'already_sent' })
  assertEquals(decideTableSequence({ priorCount: 1, lastFingerprint: 'x', fingerprint: 'y' }), { send: true, n: 2 })
  assertEquals(decideTableSequence({ priorCount: 2, lastFingerprint: 'y', fingerprint: 'z' }), { send: true, n: 3 })
  assertEquals(decideTableSequence({ priorCount: 3, lastFingerprint: 'z', fingerprint: 'w' }), { send: false, reason: 'capped' })
  assertEquals(decideTableSequence({ priorCount: 1, lastFingerprint: null, fingerprint: 'y' }), { send: false, reason: 'already_sent' })
})

// --- reminder engagement --------------------------------------------------

Deno.test('reminder: not for people who answered or changed their own items since being put down', () => {
  const base = '2026-11-17T10:00:00Z'
  assertEquals(decideReminderEngagement({ hasResponse: false, ownChangeAt: null, baselineAt: base }).send, true)
  assertEquals(decideReminderEngagement({ hasResponse: true, ownChangeAt: null, baselineAt: base }).reason, 'responded')
  assertEquals(decideReminderEngagement({ hasResponse: false, ownChangeAt: '2026-11-17T11:00:00Z', baselineAt: base }).reason, 'engaged')
  assertEquals(decideReminderEngagement({ hasResponse: false, ownChangeAt: '2026-11-17T09:00:00Z', baselineAt: base }).send, true)
  assertEquals(decideReminderEngagement({ hasResponse: false, ownChangeAt: '2026-11-17T09:00:00Z', baselineAt: null }).reason, 'engaged')
})

// --- items ----------------------------------------------------------------

const LINES: LineRow[] = [
  { id: 'l1', line_number: 1, name_original: 'Steak frites', name_english: null, quantity: 1, total_amount: 24, shared_by_all: false },
  { id: 'l2', line_number: 2, name_original: 'Vin rouge', name_english: 'Red wine', quantity: 1, total_amount: 30, shared_by_all: false },
  { id: 'l3', line_number: 3, name_original: 'Pain', name_english: null, quantity: 1, total_amount: 6, shared_by_all: true },
  { id: 'l4', line_number: 4, name_original: 'Dessert', name_english: null, quantity: 1, total_amount: 9, shared_by_all: false },
]
const claim = (line: string, user: string, amt: number, by: string | null, extra: Partial<ClaimRow> = {}): ClaimRow => ({
  line_item_id: line,
  user_id: user,
  quantity_claimed: 1,
  leftover_quantity: 0,
  amount_owed: amt,
  leftover_amount: 0,
  created_by: by,
  updated_at: '2026-11-17T10:30:00Z',
  ...extra,
})

Deno.test('personItems: own parts, who shares, who put it down, table items, leftovers ignored', () => {
  const claims = [
    claim('l1', 'u1', 24, 'payer'),
    claim('l2', 'u1', 10, 'payer'),
    claim('l2', 'u2', 10, 'payer'),
    claim('l2', 'u3', 10, 'payer'),
    claim('l3', 'u1', 1.5, 'u1'),
    claim('l4', 'u1', 3, 'payer', { leftover_quantity: 1, leftover_amount: 3 }), // a leftover share: not an item
    claim('l4', 'u2', 9, 'payer'),
  ]
  const { items, totalMinor } = personItems({ lines: LINES, claims, userId: 'u1', currency: 'GBP' })
  assertEquals(items.map((i) => [i.name, i.amountMinor, i.sharedWith, i.everyone, i.assigned]), [
    ['Steak frites', 2400, 1, false, true],
    ['Vin rouge (Red wine)', 1000, 3, false, true],
    ['Pain', 150, 1, true, false],
  ])
  assertEquals(totalMinor, 3550)
  assertEquals(personItems({ lines: LINES, claims, userId: 'nobody', currency: 'GBP' }), { items: [], totalMinor: 0 })
})

Deno.test('personItems: zero-decimal currencies stay whole', () => {
  const { totalMinor } = personItems({ lines: LINES, claims: [claim('l1', 'u1', 2400, 'payer')], userId: 'u1', currency: 'JPY' })
  assertEquals(totalMinor, 2400)
})

Deno.test('fingerprint: only items somebody else put down count, and it is stable and order-free', async () => {
  const mk = (rows: ClaimRow[]) => personItems({ lines: LINES, claims: rows, userId: 'u1', currency: 'GBP' }).items
  const a = await assignedFingerprint(mk([claim('l1', 'u1', 24, 'payer'), claim('l2', 'u1', 30, 'payer')]))
  const b = await assignedFingerprint(mk([claim('l2', 'u1', 30, 'payer'), claim('l1', 'u1', 24, 'payer')]))
  assertEquals(a, b)
  assertEquals(a.length, 12)
  // changing an assigned amount changes it
  assert(a !== (await assignedFingerprint(mk([claim('l1', 'u1', 20, 'payer'), claim('l2', 'u1', 30, 'payer')]))))
  // the person's own extra item does not
  assertEquals(a, await assignedFingerprint(mk([claim('l1', 'u1', 24, 'payer'), claim('l2', 'u1', 30, 'payer'), claim('l4', 'u1', 9, 'u1')])))
  assertEquals(await assignedFingerprint(mk([])), 'none')
})

Deno.test('latestOwnChange: only claims the person recorded themselves', () => {
  const rows = [claim('l1', 'u1', 24, 'payer', { updated_at: '2026-11-17T20:00:00Z' }), claim('l4', 'u1', 9, 'u1', { updated_at: '2026-11-17T11:00:00Z' }), claim('l2', 'u2', 9, 'u2', { updated_at: '2026-11-18T00:00:00Z' })]
  assertEquals(latestOwnChange(rows, 'u1'), '2026-11-17T11:00:00Z')
  assertEquals(latestOwnChange([rows[0]], 'u1'), null)
  assertEquals(latestOwnChange([claim('l1', 'u1', 1, null, { updated_at: null })], 'u1'), null)
})

// --- wording --------------------------------------------------------------

Deno.test('formatDeadline: plain words, UTC said out loud, year only when it differs', () => {
  assertEquals(formatDeadline('2026-11-20T18:00:00Z', NOW), 'Fri 20 Nov, 18:00 UTC')
  assertEquals(formatDeadline('2026-11-20T18:05:00+00:00', NOW), 'Fri 20 Nov, 18:05 UTC')
  assertEquals(formatDeadline('2026-11-20T23:30:00-02:00', NOW), 'Sat 21 Nov, 01:30 UTC')
  assertEquals(formatDeadline('2027-01-02T09:00:00Z', NOW), 'Sat 2 Jan 2027, 09:00 UTC')
  assertEquals(formatDeadline(null), null)
  assertEquals(formatDeadline('nope'), null)
})

Deno.test('links: personal page, app deep link; token is url-encoded, answers are hints', () => {
  assertEquals(receiptPageUrl('https://trips.fontem.ai', 'abc'), 'https://trips.fontem.ai/receipt#t=abc')
  assertEquals(receiptPageUrl('https://trips.fontem.ai', 'abc', 'done'), 'https://trips.fontem.ai/receipt#t=abc&a=done')
  assertEquals(receiptPageUrl('https://trips.fontem.ai', 'abc', 'not_there'), 'https://trips.fontem.ai/receipt#t=abc&a=not_there')
  assertEquals(receiptPageUrl('https://x', 'a b&c'), 'https://x/receipt#t=a%20b%26c')
  assertEquals(receiptAppUrl('https://trips.fontem.ai', 't1', 'e1'), 'https://trips.fontem.ai/t1?open=claim:e1')
})

const TOKEN = 'T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenabc'
const claimInput = (over: Partial<ClaimEmailInput> = {}): ClaimEmailInput => ({
  variant: 'put_down',
  recipientFirstName: 'Marj',
  payerName: 'Tim',
  receiptTitle: 'Le Bistrot',
  tripName: 'La Tania',
  currency: 'GBP',
  items: [
    { lineItemId: 'l1', name: 'Steak frites', amountMinor: 2400, sharedWith: 1, everyone: false, assigned: true },
    { lineItemId: 'l2', name: 'Wine', amountMinor: 1800, sharedWith: 3, everyone: false, assigned: true },
    { lineItemId: 'l3', name: 'Bread', amountMinor: 100, sharedWith: 8, everyone: true, assigned: false },
  ],
  totalMinor: 4200,
  deadlineIso: '2026-11-20T18:00:00Z',
  now: NOW,
  doneUrl: receiptPageUrl('https://trips.fontem.ai', TOKEN, 'done'),
  changeUrl: receiptPageUrl('https://trips.fontem.ai', TOKEN),
  notThereUrl: receiptPageUrl('https://trips.fontem.ai', TOKEN, 'not_there'),
  appUrl: receiptAppUrl('https://trips.fontem.ai', 't1', 'e1'),
  ...over,
})

Deno.test('table email: subject, items with amounts and ÷, total, deadline, rule, three links, app link', () => {
  const m = renderClaimEmail(claimInput())
  assertEquals(m.subject, 'Tim put you down for £42.00 — Le Bistrot · La Tania')
  for (const s of ['Steak frites', '£24.00', 'Wine (÷3)', '£18.00', 'Bread (shared by everyone)', 'Your total', '£42.00', 'Reply by Fri 20 Nov, 18:00 UTC.', RULE_SENTENCE]) {
    assertStringIncludes(m.text, s)
  }
  assertStringIncludes(m.html, RULE_SENTENCE)
  assertStringIncludes(m.html, 'Reply by Fri 20 Nov, 18:00 UTC.')
  assertEquals(RULE_SENTENCE, "Anything nobody claims by then is split between people who haven't said 'That's everything' (never more than an even share each), and the rest is shared by everyone.")
  for (const url of [`/receipt#t=${TOKEN}&a=done`, `/receipt#t=${TOKEN}&a=not_there`, `/receipt#t=${TOKEN}\n`, '/t1?open=claim:e1']) {
    assertStringIncludes(m.text + '\n', url)
  }
  assertStringIncludes(m.html, DONE_LABEL)
  assertStringIncludes(m.html, `/receipt#t=${TOKEN}&amp;a=done`)
  assertStringIncludes(m.html, 'Change my items')
  assertStringIncludes(m.html, "I wasn't there")
  assertStringIncludes(m.html, 'Open this receipt in the app')
  assertFalse(m.subject.includes('\n'))
})

Deno.test('table email for somebody put down for nothing: "tell us what you had" with the same links', () => {
  const m = renderClaimEmail(claimInput({ variant: 'tell_us', items: [], totalMinor: 0 }))
  assertEquals(m.subject, 'Tim added Le Bistrot — tell us what you had')
  assertStringIncludes(m.text, 'Tim added Le Bistrot (La Tania). Tell us what you had.')
  assertFalse(m.text.includes('Your total'))
  assertStringIncludes(m.text, `/receipt#t=${TOKEN}&a=done`)
  assertStringIncludes(m.text, `/receipt#t=${TOKEN}&a=not_there`)
  assertStringIncludes(m.html, 'Change my items')
})

Deno.test('reminder email: names the deadline in the subject, same links, no payer-assigned wording', () => {
  const m = renderClaimEmail(claimInput({ variant: 'reminder', deadlineIso: '2026-11-18T10:00:00Z' }))
  assertEquals(m.subject, 'Reminder: Le Bistrot closes Wed 18 Nov, 10:00 UTC · La Tania')
  assertStringIncludes(m.text, "You're down for £42.00 so far.")
  assertStringIncludes(m.text, `/receipt#t=${TOKEN}&a=done`)
  const empty = renderClaimEmail(claimInput({ variant: 'reminder', items: [], totalMinor: 0 }))
  assertStringIncludes(empty.text, "We don't have anything down for you yet.")
})

Deno.test('emails escape every piece of user text and keep subjects on one line', () => {
  const evil = '<script>alert(1)</script> & "x"\r\nBcc: a@b.c'
  const m = renderClaimEmail(
    claimInput({
      recipientFirstName: evil,
      payerName: evil,
      receiptTitle: evil,
      tripName: evil,
      items: [{ lineItemId: 'l1', name: evil, amountMinor: 100, sharedWith: 1, everyone: false, assigned: true }],
    })
  )
  assertFalse(m.html.includes('<script>'))
  assertStringIncludes(m.html, '&lt;script&gt;')
  assertFalse(/[\r\n]/.test(m.subject))
  const r = renderResultEmail({ recipientFirstName: evil, receiptTitle: evil, tripName: evil, currency: 'GBP', leftoverMinor: 300, totalMinor: 4500, appUrl: 'https://x/t?open=claim:e' })
  assertFalse(r.html.includes('<script>'))
  assertFalse(/[\r\n]/.test(r.subject))
})

Deno.test('result email: the sentence, amounts in exact mode, app link only (no token link)', () => {
  const m = renderResultEmail({ recipientFirstName: 'Marj', receiptTitle: 'Le Bistrot', tripName: 'La Tania', currency: 'GBP', leftoverMinor: 300, totalMinor: 4500, appUrl: 'https://trips.fontem.ai/t1?open=claim:e1' })
  assertEquals(m.subject, '£3.00 of unclaimed items on Le Bistrot was added to you — La Tania')
  assertStringIncludes(m.text, 'The deadline passed — £3.00 of unclaimed items from Le Bistrot was added to your share (now £45.00).')
  assertStringIncludes(m.text, 'https://trips.fontem.ai/t1?open=claim:e1')
  assertFalse(m.text.includes('/receipt#t='))
  const yen = renderResultEmail({ recipientFirstName: 'M', receiptTitle: 'R', tripName: 'T', currency: 'JPY', leftoverMinor: 5000, totalMinor: 12000, appUrl: 'u' })
  assertStringIncludes(yen.text, '¥5,000')
})

Deno.test('claimEmailSubject: pure helper agrees with the rendered subject', () => {
  const i = claimInput()
  assertEquals(claimEmailSubject(i), renderClaimEmail(i).subject)
})

// --- database answers -> HTTP ---------------------------------------------

Deno.test('isMissingFunction: PostgREST and Postgres spellings', () => {
  assert(isMissingFunction({ code: 'PGRST202' }))
  assert(isMissingFunction({ code: '42883' }))
  assert(isMissingFunction({ message: 'Could not find the function public.send_receipt_to_table(p_expense_id) in the schema cache' }))
  assertFalse(isMissingFunction({ code: 'P0001', message: 'closed' }))
  assertFalse(isMissingFunction(null))
})

Deno.test('mapSendRpcError: hints become coded statuses and the database text is never echoed', () => {
  assertEquals(mapSendRpcError({ code: 'PGRST202' }), { status: 409, body: { success: false, reason: 'not_available' } })
  assertEquals(mapSendRpcError({ hint: 'auth' }).status, 401)
  assertEquals(mapSendRpcError({ hint: 'forbidden' }).status, 403)
  assertEquals(mapSendRpcError({ hint: 'not_found' }).status, 403)
  for (const reason of ['not_itemised', 'frozen', 'deadline_passed', 'bad_deadline', 'not_sent']) {
    assertEquals(mapSendRpcError({ hint: reason, message: 'secret detail' }), { status: 409, body: { success: false, reason } })
  }
  assertEquals(mapSendRpcError({ code: '22023' }).body, { success: false, reason: 'bad_deadline' })
  assertEquals(mapSendRpcError({ code: 'XX000', message: 'boom with detail' }), { status: 502, body: { success: false, reason: 'state_failed' } })
  assertFalse(JSON.stringify(mapSendRpcError({ code: 'XX000', message: 'boom with detail' })).includes('detail'))
})

Deno.test('summariseSendOutcomes: counts only (sent / already_told / skipped / failed); no per-recipient reasons leak', () => {
  const ok = { sent: true, reason: null } as const
  const c = (sent: number, already_told: number, skipped: number, failed: number, email_configured = true) => ({ sent, already_told, skipped, failed, email_configured })
  assertEquals(summariseSendOutcomes([]), { status: 200, body: { success: true, ...c(0, 0, 0, 0) } })
  assertEquals(summariseSendOutcomes([ok, { sent: false, reason: 'opt_out' }, { sent: false, reason: 'no_email' }, { sent: false, reason: 'already_sent' }]), {
    status: 200,
    body: { success: true, ...c(1, 1, 2, 0) },
  })
  assertEquals(summariseSendOutcomes([ok, { sent: false, reason: 'send_failed' }]).body, { success: true, ...c(1, 0, 0, 1) })
  assertEquals(summariseSendOutcomes([{ sent: false, reason: 'send_failed' }, { sent: false, reason: 'opt_out' }, { sent: false, reason: 'already_sent' }]), {
    status: 502,
    body: { success: false, reason: 'send_failed', ...c(0, 1, 1, 1) },
  })
  assertEquals(summariseSendOutcomes([{ sent: false, reason: 'token_failed' }]).status, 502)
  assertEquals(summariseSendOutcomes([{ sent: false, reason: 'capped' }, { sent: false, reason: 'capped' }]), { status: 409, body: { success: false, reason: 'capped' } })
  assertEquals(summariseSendOutcomes([{ sent: false, reason: 'capped' }, { sent: false, reason: 'opt_out' }]).status, 200)
  // no provider: the app can say emails are not set up
  assertEquals(summariseSendOutcomes([{ sent: false, reason: 'no_channel' }, { sent: false, reason: 'no_channel' }]).body, { success: true, ...c(0, 0, 2, 0, false) })
})

// --- the public page ------------------------------------------------------

const PEEK = { result: 'ok', expense: { id: 'e1', title: 'Le Bistrot' }, me: { first_name: 'Marj' }, editable: true, my_items: [], available_items: [] }

Deno.test('peek mapping: ok carries the receipt without `result`; token problems are distinct but never reveal more', () => {
  const ok = mapPeekResult(PEEK)
  assertEquals(ok.status, 200)
  assertEquals(ok.body.state, 'ok')
  assertFalse('result' in (ok.body.receipt as object))
  assertEquals((ok.body.receipt as { editable: boolean }).editable, true)
  assertEquals(mapPeekResult({ result: 'expired' }).body, { state: 'expired' })
  assertEquals(mapPeekResult({ result: 'revoked' }).body, { state: 'revoked' })
  assertEquals(mapPeekResult({ result: 'not_found' }).body, { state: 'invalid' })
  for (const junk of [null, undefined, 5, 'x', [], {}, { result: 'weird' }, { result: 'ok' }]) assertEquals(mapPeekResult(junk).body, { state: 'invalid' })
})

Deno.test('act mapping: ok, refused (current truth shown), token problems, junk', () => {
  const ok = mapActResult({ result: 'ok', action: 'done', changed: true, state: PEEK }, 'done')
  assertEquals(ok.body.state, 'ok')
  assertEquals(ok.body.changed, true)
  assertEquals(ok.body.action, 'done')
  assert('receipt' in ok.body)
  assertEquals(mapActResult({ result: 'ok', changed: false, state: PEEK }, 'toggle').body.changed, false)
  assertEquals(mapActResult({ result: 'ok', state: { result: 'not_found' } }, 'done').body, { state: 'invalid' })

  const refused = mapActResult({ result: 'refused', reason: 'deadline_passed', message: 'Claiming has closed\nfor this receipt', state: PEEK }, 'toggle')
  assertEquals(refused.body.state, 'refused')
  assertEquals(refused.body.reason, 'deadline_passed')
  assertEquals(refused.body.message, REASON_MESSAGES.deadline_passed) // plain wording comes from our map, not the database text
  assertEquals(mapActResult({ result: 'refused', reason: 'surprise', message: 'Some\ndetail', state: null }, 'done').body.message, 'Some detail') // unknown reason: oneLine'd database text
  assert('receipt' in refused.body)
  assertEquals(mapActResult({ result: 'refused', reason: 'surprise', state: null }, 'done').body.reason, 'error')
  assertFalse('receipt' in mapActResult({ result: 'refused', reason: 'frozen', state: null }, 'done').body)

  assertEquals(mapActResult({ result: 'expired' }, 'done').body, { state: 'expired' })
  assertEquals(mapActResult({ result: 'revoked' }, 'done').body, { state: 'revoked' })
  assertEquals(mapActResult({ result: 'not_found' }, 'done').body, { state: 'invalid' })
  for (const junk of [null, 5, [], {}, { result: 'weird' }]) assertEquals(mapActResult(junk, 'done').body, { state: 'invalid' })
})

Deno.test('reasons: claims_closed / has_leftovers / deadline_passed map to plain messages; the old `closed` spelling is understood', () => {
  for (const reason of ['claims_closed', 'has_leftovers', 'deadline_passed', 'frozen', 'not_open', 'not_itemised', 'has_claims', 'payer', 'not_on_receipt']) {
    const m = mapActResult({ result: 'refused', reason, message: 'db text', state: PEEK }, 'done').body
    assertEquals(m.reason, reason)
    assertEquals(m.message, REASON_MESSAGES[reason])
    assert(String(m.message).length > 10 && !String(m.message).includes('_'))
  }
  assertEquals(mapActResult({ result: 'refused', reason: 'closed', state: null }, 'done').body.reason, 'claims_closed')
  // peek: a read-only receipt says why in words (and the reason is normalised)
  for (const reason of ['claims_closed', 'deadline_passed', 'frozen', 'not_open', 'not_itemised']) {
    const p = mapPeekResult({ ...PEEK, editable: false, closed_reason: reason }).body
    assertEquals(p.message, REASON_MESSAGES[reason])
    assertEquals((p.receipt as { closed_reason: string }).closed_reason, reason)
  }
  assertEquals((mapPeekResult({ ...PEEK, editable: false, closed_reason: 'closed' }).body.receipt as { closed_reason: string }).closed_reason, 'claims_closed')
  assertFalse('message' in mapPeekResult({ ...PEEK, closed_reason: null }).body)
  assertEquals(mapSendRpcError({ hint: 'claims_closed' }), { status: 409, body: { success: false, reason: 'claims_closed' } })
  assertEquals(mapSendRpcError({ hint: 'closed' }), { status: 409, body: { success: false, reason: 'claims_closed' } })
})

Deno.test('reminder keys are per deadline day (cap 2); result keys carry the amount (second notice only if it changed, cap 2)', () => {
  const k1 = reminderNoticeKey('e', 'u', '2026-11-20T18:00:00Z')
  const k2 = reminderNoticeKey('e', 'u', '2026-11-25T18:00:00Z')
  assertEquals(reminderNoticeKey('e', 'u', '2026-11-20T09:00:00Z'), k1) // same day, moved by hours: same key
  assertEquals(decideReminderSequence({ priorKeys: [], key: k1 }), { send: true })
  assertEquals(decideReminderSequence({ priorKeys: [k1], key: k1 }), { send: false, reason: 'already_sent' })
  assertEquals(decideReminderSequence({ priorKeys: [k1], key: k2 }), { send: true }) // reopened with a new deadline
  assertEquals(decideReminderSequence({ priorKeys: [k1, k2], key: reminderNoticeKey('e', 'u', '2026-12-01T18:00:00Z') }), { send: false, reason: 'capped' })
  assertEquals(deadlineDay(null), 'none')

  const r = (n: number) => resultNoticeKey('e', 'u', n)
  assertEquals(resultKeyAmount(r(450)), 450)
  assertEquals(resultKeyAmount('notice:receipt:e:u:result'), null)
  assertEquals(decideResultSequence({ priorKeys: [], leftoverMinor: 450 }), { send: true })
  assertEquals(decideResultSequence({ priorKeys: [r(450)], leftoverMinor: 450 }), { send: false, reason: 'already_sent' }) // re-closed, same amount
  assertEquals(decideResultSequence({ priorKeys: [r(450)], leftoverMinor: 300 }), { send: true }) // re-closed, amount changed
  assertEquals(decideResultSequence({ priorKeys: [r(450), r(300)], leftoverMinor: 100 }), { send: false, reason: 'capped' })
  assertEquals(decideResultSequence({ priorKeys: [r(450), r(300)], leftoverMinor: 300 }), { send: false, reason: 'already_sent' })
})

Deno.test('decideTableSequence: force skips only the "unchanged" rule, never the cap', () => {
  assertEquals(decideTableSequence({ priorCount: 1, lastFingerprint: 'x', fingerprint: 'x', force: true }), { send: true, n: 2 })
  assertEquals(decideTableSequence({ priorCount: 1, lastFingerprint: null, fingerprint: 'x', force: true }), { send: true, n: 2 })
  assertEquals(decideTableSequence({ priorCount: 3, lastFingerprint: 'x', fingerprint: 'y', force: true }), { send: false, reason: 'capped' })
  assertEquals(decideTableSequence({ priorCount: 0, lastFingerprint: null, fingerprint: 'x', force: true }), { send: true, n: 1 })
})

Deno.test('latestOwnChange ignores table-item rows (derived re-splits)', () => {
  const rows = [claim('t1', 'u1', 5, 'u1', { updated_at: '2026-11-18T00:00:00Z' }), claim('l4', 'u1', 9, 'u1', { updated_at: '2026-11-17T11:00:00Z' })]
  assertEquals(latestOwnChange(rows, 'u1', [{ id: 't1', shared_by_all: true }, { id: 'l4', shared_by_all: false }]), '2026-11-17T11:00:00Z')
  assertEquals(latestOwnChange(rows.slice(0, 1), 'u1', [{ id: 't1', shared_by_all: true }]), null)
})

Deno.test('CORS origin check reuses the payment helper: app origin and listed extras only', () => {
  const origins = allowedOrigins('https://trips.fontem.ai', 'http://localhost:5173, https://preview.example.com, http://evil.example.com')
  assert(isAllowedOrigin('https://trips.fontem.ai', origins))
  assert(isAllowedOrigin('http://localhost:5173', origins))
  assert(isAllowedOrigin('https://preview.example.com', origins))
  assertFalse(isAllowedOrigin('http://evil.example.com', origins))
  assertFalse(isAllowedOrigin('https://trips.fontem.ai.evil.com', origins))
  assertFalse(isAllowedOrigin(null, origins))
})

Deno.test('rate keys separate reads from writes and never contain more than the given value', () => {
  assertEquals(rateKey('ip', '1.2.3.4', false), 'receipt:ip:1.2.3.4')
  assertEquals(rateKey('tok', 'abc', true), 'receipt:tok:abc:post')
})
