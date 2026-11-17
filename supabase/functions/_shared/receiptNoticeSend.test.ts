import { assert, assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert@1'
import type { EmailMessage, EmailSender } from './emailSender.ts'
import { sendReceiptReminderNotice, sendReceiptResultNotice, sendReceiptTableNotice, sendReceiptTableNotices, type SupabaseClient } from './receiptNoticeSend.ts'

type Row = Record<string, unknown>

/** A tiny in-memory stand-in for the parts of supabase-js the senders use. */
let tick = Date.now() - 3600_000
const nextTime = () => new Date((tick += 1000)).toISOString()

function fakeAdmin(
  tables: Record<string, Row[]>,
  rpc: (fn: string, args: Record<string, unknown>) => unknown = () => ({ result: 'issued' }),
  opts: { missingColumns?: boolean } = {}
) {
  const calls = { rpc: [] as Array<{ fn: string; args: Record<string, unknown> }> }
  const builder = (name: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'delete' | 'update' = 'select'
    let patch: Row = {}
    let head = false
    const run = () => {
      const rows = (tables[name] ??= [])
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (mode === 'delete') {
        tables[name] = rows.filter((r) => !hit.includes(r))
        return { data: null, error: null }
      }
      if (mode === 'update') {
        for (const r of hit) Object.assign(r, patch)
        return { data: null, error: null }
      }
      return head ? { data: null, error: null, count: hit.length } : { data: hit, error: null }
    }
    const b: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => ((head = !!o?.head), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      gte: (c: string, v: unknown) => (filters.push((r) => String(r[c]) >= String(v)), b),
      delete: () => ((mode = 'delete'), b),
      update: (p: Row) => ((mode = 'update'), (patch = p), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      maybeSingle: () => {
        if (opts.missingColumns && name === 'expenses') return Promise.resolve({ data: null, error: { code: '42703', message: 'column expenses.claims_sent_at does not exist' } })
        const r = run()
        return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null })
      },
      insert: (row: Row) => {
        const rows = (tables[name] ??= [])
        if (name === 'notifications' && rows.some((r) => r.dedupe_key === row.dedupe_key)) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
        }
        rows.push(name === 'notifications' ? { sent_at: nextTime(), ...row } : row)
        return Promise.resolve({ error: null })
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  const client = {
    from: (n: string) => builder(n),
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args })
      const data = rpc(fn, args)
      if (data && typeof data === 'object' && '__error' in (data as object)) return Promise.resolve({ data: null, error: { message: 'rpc failed' } })
      return Promise.resolve({ data, error: null })
    },
  }
  return { client: client as unknown as SupabaseClient, tables, calls }
}

function fakeSender(opts: { available?: boolean; fail?: boolean } = {}) {
  const sent: EmailMessage[] = []
  const sender: EmailSender = {
    channel: 'email',
    available: opts.available ?? true,
    send: (m) => {
      if (opts.fail) return Promise.reject(new Error('boom'))
      sent.push(m)
      return Promise.resolve({ provider: 'test', providerMessageId: null })
    },
  }
  return { sender, sent }
}

const DEADLINE = new Date(Date.now() + 3 * 864e5).toISOString()
const claimRow = (line: string, user: string, amt: number, by: string | null, extra: Row = {}): Row => ({
  expense_id: 'e1', line_item_id: line, user_id: user, quantity_claimed: 1, leftover_quantity: 0, amount_owed: amt, leftover_amount: 0, created_by: by, updated_at: nextTime(), ...extra,
})

const base = () => ({
  expenses: [{ id: 'e1', trip_id: 't1', description: 'Le <b>Bistrot</b>', currency: 'GBP', amount: 66, paid_by: 'payer', claim_deadline: DEADLINE, claims_sent_at: new Date(Date.now() - 600_000).toISOString(), claims_closed_at: null } as Row],
  trips: [{ id: 't1', name: 'La Tania', base_currency: 'GBP', settlement_snapshot: null as unknown, receipt_notices_enabled: true } as Row],
  users: [
    { id: 'payer', email: 'p@x.co', full_name: 'Tim Lam', first_name: 'Tim', email_notifications_enabled: true },
    { id: 'marj', email: 'm@x.co', full_name: 'Marj Smith', first_name: 'Marj', email_notifications_enabled: true },
    { id: 'lou', email: 'l@x.co', full_name: 'Louis', first_name: null, email_notifications_enabled: true },
  ] as Row[],
  trip_participants: [
    { trip_id: 't1', user_id: 'payer', active: true },
    { trip_id: 't1', user_id: 'marj', active: true },
    { trip_id: 't1', user_id: 'lou', active: true },
  ] as Row[],
  expense_line_items: [
    { id: 'l1', expense_id: 'e1', line_number: 1, name_original: 'Steak frites', name_english: null, quantity: 1, total_amount: 24, shared_by_all: false },
    { id: 'l2', expense_id: 'e1', line_number: 2, name_original: 'Wine', name_english: null, quantity: 1, total_amount: 30, shared_by_all: false },
  ] as Row[],
  expense_item_claims: [claimRow('l1', 'marj', 24, 'payer'), claimRow('l2', 'marj', 10, 'payer'), claimRow('l2', 'lou', 10, 'payer')] as Row[],
  expense_claim_responses: [] as Row[],
  notifications: [] as Row[],
  activity_feed: [] as Row[],
})
const APP = 'https://trips.fontem.ai'
const T = (userId = 'marj', extra: Record<string, unknown> = {}) => ({ expenseId: 'e1', userId, actorId: 'payer', appBaseUrl: APP, ...extra })

// --- table -----------------------------------------------------------------

Deno.test('table: sends once with a token link; dedupe + marker rows; only the hash reaches the database', async () => {
  const d = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  assertEquals(await sendReceiptTableNotice(d.client, sender, T()), { sent: true, reason: null })
  assertEquals(sent.length, 1)
  assertEquals(sent[0].toEmail, 'm@x.co')
  assertEquals(sent[0].subject, 'Tim put you down for £34.00 — Le <b>Bistrot</b> · La Tania')
  assertStringIncludes(sent[0].text, 'Steak frites: £24.00')
  assertStringIncludes(sent[0].text, 'Wine (÷2): £10.00')
  assertStringIncludes(sent[0].text, 'Reply by ')
  assertStringIncludes(sent[0].text, 'UTC.')
  const m = /\/receipt#t=([A-Za-z0-9_-]{43})&a=done/.exec(sent[0].text)
  assert(m, 'done link')
  assert(sent[0].text.includes(`/receipt#t=${m[1]}&a=not_there`))
  assert(sent[0].text.includes('/t1?open=claim:e1'))
  assertFalse(sent[0].html!.includes('<b>Bistrot</b>'))
  assertStringIncludes(sent[0].html!, 'Le &lt;b&gt;Bistrot&lt;/b&gt;')
  const n = d.tables.notifications
  assertEquals(n.map((r) => [r.kind, r.entity_type, r.entity_id, r.user_id]), [['receipt_table', 'expense', 'e1', 'marj'], ['receipt_table_fp', 'expense', 'e1', 'marj']])
  assertEquals(n[0].dedupe_key, 'notice:receipt:e1:marj:table')
  assert(String(n[1].dedupe_key).startsWith('notice:receipt:e1:marj:tablefp:1:'))
  // the raw token is nowhere in the database or the rpc arguments
  const call = d.calls.rpc[0]
  assertEquals(call.fn, 'issue_receipt_claim_token')
  assertEquals(call.args.p_user_id, 'marj')
  assertEquals((call.args.p_token_hash as string).length, 64)
  assertFalse(JSON.stringify(call.args).includes(m[1]))
  assertFalse(JSON.stringify(d.tables.notifications).includes(m[1]))
})

Deno.test('table: a second or concurrent call sends nothing', async () => {
  const d = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  const [a, b] = await Promise.all([sendReceiptTableNotice(d.client, sender, T()), sendReceiptTableNotice(d.client, sender, T())])
  assertEquals([a.sent, b.sent].sort(), [false, true])
  assertEquals(sent.length, 1)
  assertEquals((await sendReceiptTableNotice(d.client, sender, T())).reason, 'already_sent')
  assertEquals(sent.length, 1)
})

Deno.test('table: re-sent only when the payer changes that person\'s items; their own edits do not; at most 3', async () => {
  const d = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  await sendReceiptTableNotice(d.client, sender, T())
  // Marj adds an item herself: not the payer's change
  d.tables.expense_item_claims.push(claimRow('l1', 'marj', 0.01, 'marj', { line_item_id: 'l3' }))
  assertEquals((await sendReceiptTableNotice(d.client, sender, T())).reason, 'already_sent')
  // the payer moves her wine share: change -> second email
  const wine = d.tables.expense_item_claims.find((r) => r.line_item_id === 'l2' && r.user_id === 'marj')!
  wine.amount_owed = 15
  const second = await sendReceiptTableNotice(d.client, sender, T())
  assertEquals(second, { sent: true, reason: null })
  assertEquals(sent.length, 2)
  assert(d.tables.notifications.some((r) => r.dedupe_key === 'notice:receipt:e1:marj:table:2'))
  // no further change -> nothing
  assertEquals((await sendReceiptTableNotice(d.client, sender, T())).reason, 'already_sent')
  // third email allowed, a fourth never
  wine.amount_owed = 12
  assertEquals((await sendReceiptTableNotice(d.client, sender, T())).sent, true)
  wine.amount_owed = 11
  assertEquals((await sendReceiptTableNotice(d.client, sender, T())).reason, 'capped')
  assertEquals(sent.length, 3)
  assertEquals(d.tables.notifications.filter((r) => r.kind === 'receipt_table').length, 3)
})

Deno.test('table: somebody put down for nothing gets "tell us what you had" with the same buttons', async () => {
  const d = fakeAdmin({ ...base(), expense_item_claims: [claimRow('l1', 'marj', 24, 'payer')] })
  const { sender, sent } = fakeSender()
  assert((await sendReceiptTableNotice(d.client, sender, T('lou'))).sent)
  assertEquals(sent[0].subject, 'Tim added Le <b>Bistrot</b> — tell us what you had')
  assertStringIncludes(sent[0].text, 'Hi Louis,')
  assertStringIncludes(sent[0].text, '&a=done')
  assertStringIncludes(sent[0].text, '&a=not_there')
  assertFalse(sent[0].text.includes('Your total'))
})

Deno.test('table: every gate sends nothing and leaves no dedupe row', async () => {
  const cases: Array<[string, (d: ReturnType<typeof base>) => void, string, Record<string, unknown>?]> = [
    ['opt out', (d) => void (d.users[1].email_notifications_enabled = false), 'opt_out'],
    ['no email', (d) => void (d.users[1].email = null), 'no_email'],
    ['trip switch off', (d) => void (d.trips[0].receipt_notices_enabled = false), 'notices_off'],
    ['frozen', (d) => void (d.trips[0].settlement_snapshot = { frozen: true }), 'frozen'],
    ['closed', (d) => void (d.expenses[0].claims_closed_at = new Date().toISOString()), 'closed'],
    ['deadline passed', (d) => void (d.expenses[0].claim_deadline = new Date(Date.now() - 1000).toISOString()), 'closed'],
    ['not sent', (d) => void (d.expenses[0].claims_sent_at = null), 'not_open'],
    ['the caller themself', () => {}, 'same_person', { actorId: 'marj' }],
    ['already said done', (d) => void d.expense_claim_responses.push({ expense_id: 'e1', user_id: 'marj', response: 'done' }), 'not_on_receipt'],
    ['recipient not on the trip', (d) => void (d.trip_participants = d.trip_participants.filter((p) => p.user_id !== 'marj')), 'not_found'],
    ['payer not on the trip', (d) => void (d.trip_participants = d.trip_participants.filter((p) => p.user_id !== 'payer')), 'not_found'],
    ['no such expense', (d) => void (d.expenses = []), 'not_found'],
  ]
  for (const [label, mutate, reason, extra] of cases) {
    const d = base()
    mutate(d)
    const f = fakeAdmin(d)
    const { sender, sent } = fakeSender()
    const r = await sendReceiptTableNotice(f.client, sender, T('marj', extra))
    assertEquals(r.reason, reason, label)
    assertEquals(sent.length, 0, label)
    assertEquals(f.tables.notifications.length, 0, label)
    assertEquals(f.calls.rpc.length, 0, `${label}: no token issued`)
  }
  const f = fakeAdmin(base())
  assertEquals((await sendReceiptTableNotice(f.client, fakeSender({ available: false }).sender, T())).reason, 'no_channel')
})

Deno.test('table: the shared daily cap of 6 receipt notices applies (any kind), older ones do not count', async () => {
  const d = base()
  const recent = (i: number): Row => ({ user_id: 'marj', kind: i % 2 ? 'receipt_reminder' : 'receipt_result', dedupe_key: `k${i}`, entity_id: `other${i}`, sent_at: new Date(Date.now() - 1000).toISOString() })
  d.notifications = [0, 1, 2, 3, 4].map(recent)
  let f = fakeAdmin(d)
  assert((await sendReceiptTableNotice(f.client, fakeSender().sender, T())).sent, '5 in the last day: still room')
  d.notifications = [0, 1, 2, 3, 4, 5].map(recent)
  f = fakeAdmin(d)
  const s = fakeSender()
  assertEquals((await sendReceiptTableNotice(f.client, s.sender, T())).reason, 'capped')
  assertEquals(s.sent.length, 0)
  assertEquals(f.tables.notifications.length, 6)
  d.notifications = [0, 1, 2, 3, 4, 5].map((i) => ({ ...recent(i), sent_at: new Date(Date.now() - 2 * 864e5).toISOString() }))
  f = fakeAdmin(d)
  assert((await sendReceiptTableNotice(f.client, fakeSender().sender, T())).sent, 'older than 24h does not count')
  // payment notices are a different kind and do not count
  d.notifications = [0, 1, 2, 3, 4, 5].map((i) => ({ ...recent(i), kind: 'payment_paid_notice' }))
  f = fakeAdmin(d)
  assert((await sendReceiptTableNotice(f.client, fakeSender().sender, T())).sent)
})

Deno.test('table: a failed send releases both rows so a retry can send; a refused token does too', async () => {
  const d = fakeAdmin(base())
  const bad = fakeSender({ fail: true })
  assertEquals((await sendReceiptTableNotice(d.client, bad.sender, T())).reason, 'send_failed')
  assertEquals(d.tables.notifications.length, 0)
  assert((await sendReceiptTableNotice(d.client, fakeSender().sender, T())).sent)

  for (const [result, reason] of [['not_on_receipt', 'not_on_receipt'], ['closed', 'closed'], ['frozen', 'frozen'], ['not_sent', 'not_open'], ['bad_hash', 'token_failed']] as const) {
    const f = fakeAdmin(base(), () => ({ result }))
    const s = fakeSender()
    assertEquals((await sendReceiptTableNotice(f.client, s.sender, T())).reason, reason, result)
    assertEquals(f.tables.notifications.length, 0, result)
    assertEquals(s.sent.length, 0, result)
  }
  const errored = fakeAdmin(base(), () => ({ __error: true }))
  assertEquals((await sendReceiptTableNotice(errored.client, fakeSender().sender, T())).reason, 'token_failed')
  assertEquals(errored.tables.notifications.length, 0)
})

Deno.test('table: fail-soft when migration B is not applied', async () => {
  const f = fakeAdmin(base(), undefined, { missingColumns: true })
  const s = fakeSender()
  assertEquals((await sendReceiptTableNotice(f.client, s.sender, T())).reason, 'not_available')
  assertEquals(s.sent.length, 0)
  assertEquals(f.tables.notifications.length, 0)
})

Deno.test('table batch: one outcome per person, duplicates collapsed, each with its own token', async () => {
  const d = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  const out = await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj', 'lou', 'marj', 'payer'], actorId: 'payer', appBaseUrl: APP })
  assertEquals(out.map((o) => [o.sent, o.reason]), [[true, null], [true, null], [false, 'same_person']])
  assertEquals(sent.length, 2)
  const tokens = sent.map((m) => /t=([A-Za-z0-9_-]{43})/.exec(m.text)![1])
  assert(tokens[0] !== tokens[1])
  const again = await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj', 'lou'], actorId: 'payer', appBaseUrl: APP })
  assertEquals(again.map((o) => o.reason), ['already_sent', 'already_sent'])
  assertEquals(sent.length, 2)
})

// --- reminder --------------------------------------------------------------

const soon = () => new Date(Date.now() + 20 * 3600_000).toISOString()
const R = (userId = 'marj') => ({ expenseId: 'e1', userId, appBaseUrl: APP })

Deno.test('reminder: once, with a fresh token, only inside the 25h window', async () => {
  const b = base()
  b.expenses[0].claim_deadline = soon()
  const d = fakeAdmin(b)
  const { sender, sent } = fakeSender()
  assertEquals(await sendReceiptReminderNotice(d.client, sender, R()), { sent: true, reason: null })
  assertStringIncludes(sent[0].subject, 'Reminder: Le <b>Bistrot</b> closes ')
  assertStringIncludes(sent[0].text, '&a=done')
  const day = b.expenses[0].claim_deadline!.toString().slice(0, 10)
  assert(d.tables.notifications.some((r) => r.dedupe_key === `notice:receipt:e1:marj:reminder:${day}` && r.kind === 'receipt_reminder'))
  assertEquals((await sendReceiptReminderNotice(d.client, sender, R())).reason, 'already_sent')
  assertEquals(sent.length, 1)

  const far = fakeAdmin(base()) // deadline 3 days out
  assertEquals((await sendReceiptReminderNotice(far.client, fakeSender().sender, R())).reason, 'not_due')
})

Deno.test('reminder: not for people who answered, or changed their own items since being put down, or when gates fail', async () => {
  const mk = (mutate: (d: ReturnType<typeof base>) => void) => {
    const b = base()
    b.expenses[0].claim_deadline = soon()
    mutate(b)
    return fakeAdmin(b)
  }
  const cases: Array<[string, (d: ReturnType<typeof base>) => void, string]> = [
    ['responded done', (d) => void d.expense_claim_responses.push({ expense_id: 'e1', user_id: 'marj', response: 'done' }), 'responded'],
    ['responded not there', (d) => void d.expense_claim_responses.push({ expense_id: 'e1', user_id: 'marj', response: 'not_there' }), 'responded'],
    ['changed own items', (d) => void d.expense_item_claims.push(claimRow('l1', 'marj', 5, 'marj', { line_item_id: 'l9', updated_at: new Date().toISOString() })), 'engaged'],
    ['opt out', (d) => void (d.users[1].email_notifications_enabled = false), 'opt_out'],
    ['trip switch off', (d) => void (d.trips[0].receipt_notices_enabled = false), 'notices_off'],
    ['frozen', (d) => void (d.trips[0].settlement_snapshot = {}), 'frozen'],
    ['closed', (d) => void (d.expenses[0].claims_closed_at = new Date().toISOString()), 'closed'],
  ]
  for (const [label, mutate, reason] of cases) {
    const f = mk(mutate)
    const s = fakeSender()
    assertEquals((await sendReceiptReminderNotice(f.client, s.sender, R())).reason, reason, label)
    assertEquals(s.sent.length, 0, label)
    assertEquals(f.tables.notifications.length, 0, label)
  }
  // an assigned change by the payer (created_by = payer) is not "the person changed something"
  const f = mk((d) => void d.expense_item_claims.push(claimRow('l1', 'marj', 5, 'payer', { line_item_id: 'l9', updated_at: new Date().toISOString() })))
  assert((await sendReceiptReminderNotice(f.client, fakeSender().sender, R())).sent)
})

Deno.test('reminder: engagement is measured from the last table email', async () => {
  const b = base()
  b.expenses[0].claim_deadline = soon()
  const own = claimRow('l1', 'marj', 5, 'marj', { line_item_id: 'l9', updated_at: new Date(Date.now() - 3600_000).toISOString() })
  b.expense_item_claims.push(own)
  // table email sent AFTER her edit: her edit predates being put down again, so she still gets the reminder
  b.notifications.push({ user_id: 'marj', kind: 'receipt_table', entity_id: 'e1', dedupe_key: 'notice:receipt:e1:marj:table', sent_at: new Date(Date.now() - 60_000).toISOString() })
  const f = fakeAdmin(b)
  assert((await sendReceiptReminderNotice(f.client, fakeSender().sender, R())).sent)
})

// --- result ----------------------------------------------------------------

const closedBase = () => {
  const b = base()
  b.expenses[0].claims_closed_at = new Date().toISOString()
  return b
}
const RES = (userId = 'marj', over: Record<string, unknown> = {}) => ({ expenseId: 'e1', userId, leftoverAmountMinor: 300, totalMinor: 4500, appBaseUrl: APP, ...over })

Deno.test('result: once per person, exact amounts, no token issued, never the payer', async () => {
  const d = fakeAdmin(closedBase())
  const { sender, sent } = fakeSender()
  assertEquals(await sendReceiptResultNotice(d.client, sender, RES()), { sent: true, reason: null })
  assertEquals(sent[0].subject, '£3.00 of unclaimed items on Le <b>Bistrot</b> was added to you — La Tania')
  assertStringIncludes(sent[0].text, 'was added to your share (now £45.00).')
  assertFalse(sent[0].text.includes('/receipt#t='))
  assertEquals(d.calls.rpc.length, 0)
  assertEquals(d.tables.notifications[0].dedupe_key, 'notice:receipt:e1:marj:result:300')
  assertEquals(d.tables.notifications[0].kind, 'receipt_result')
  assertEquals((await sendReceiptResultNotice(d.client, sender, RES())).reason, 'already_sent')
  assertEquals((await sendReceiptResultNotice(d.client, sender, RES('payer'))).reason, 'same_person') // never the payer about their own receipt
  assertEquals(sent.length, 1)
})

Deno.test('result: nothing for a zero or invalid amount, an open receipt, opted-out, switched off; frozen trips still get it', async () => {
  const s = fakeSender()
  for (const bad of [0, -5, 1.5, Number.NaN]) {
    const f = fakeAdmin(closedBase())
    assertEquals((await sendReceiptResultNotice(f.client, s.sender, RES('marj', { leftoverAmountMinor: bad }))).reason, 'zero_amount')
    assertEquals(f.tables.notifications.length, 0)
  }
  assertEquals((await sendReceiptResultNotice(fakeAdmin(base()).client, s.sender, RES())).reason, 'not_closed')
  const o = closedBase()
  o.users[1].email_notifications_enabled = false
  assertEquals((await sendReceiptResultNotice(fakeAdmin(o).client, s.sender, RES())).reason, 'opt_out')
  const off = closedBase()
  off.trips[0].receipt_notices_enabled = false
  assertEquals((await sendReceiptResultNotice(fakeAdmin(off).client, s.sender, RES())).reason, 'notices_off')
  const frozen = closedBase()
  frozen.trips[0].settlement_snapshot = { a: 1 }
  assert((await sendReceiptResultNotice(fakeAdmin(frozen).client, s.sender, RES())).sent)
  assertEquals((await sendReceiptResultNotice(fakeAdmin(closedBase()).client, fakeSender({ fail: true }).sender, RES())).reason, 'send_failed')
  const nobody = fakeAdmin({ ...closedBase(), trip_participants: [{ trip_id: 't1', user_id: 'payer', active: true }] })
  assertEquals((await sendReceiptResultNotice(nobody.client, s.sender, RES())).reason, 'not_found')
})

Deno.test('result: a failed send releases the dedupe row; the daily cap applies', async () => {
  const d = fakeAdmin(closedBase())
  assertEquals((await sendReceiptResultNotice(d.client, fakeSender({ fail: true }).sender, RES())).reason, 'send_failed')
  assertEquals(d.tables.notifications.length, 0)
  assert((await sendReceiptResultNotice(d.client, fakeSender().sender, RES())).sent)
  const c = closedBase()
  c.notifications = [0, 1, 2, 3, 4, 5].map((i) => ({ user_id: 'marj', kind: 'receipt_table', dedupe_key: `x${i}`, entity_id: `o${i}`, sent_at: new Date().toISOString() }))
  assertEquals((await sendReceiptResultNotice(fakeAdmin(c).client, fakeSender().sender, RES())).reason, 'capped')
})

// --- phase 2 review fixes ---------------------------------------------------------------------------------------

Deno.test('table/reminder: the payer is never emailed about their own receipt, even when an organiser sent it', async () => {
  const b0 = base()
  b0.expenses[0].claim_deadline = new Date(Date.now() + 10 * 3600_000).toISOString()
  const d = fakeAdmin(b0)
  const { sender, sent } = fakeSender()
  assertEquals((await sendReceiptTableNotice(d.client, sender, T('payer', { actorId: 'lou' }))).reason, 'same_person')
  assertEquals((await sendReceiptReminderNotice(d.client, sender, { expenseId: 'e1', userId: 'payer', appBaseUrl: APP })).reason, 'same_person')
  assertEquals(sent.length, 0)
  assertEquals(d.tables.notifications.length, 0)
})

Deno.test('table/reminder: declined, cancelled and inactive participants are not emailed, unless they hold their own claim', async () => {
  for (const patch of [{ active: false }, { confirmation_status: 'declined' }, { confirmation_status: 'cancelled' }]) {
    const b = base()
    Object.assign(b.trip_participants[2], patch) // lou
    const d = fakeAdmin(b)
    const { sender, sent } = fakeSender()
    assertEquals((await sendReceiptTableNotice(d.client, sender, T('lou'))).reason, 'not_on_receipt')
    assertEquals((await sendReceiptReminderNotice(d.client, sender, { expenseId: 'e1', userId: 'lou', appBaseUrl: APP })).sent, false)
    assertEquals(sent.length, 0)
    assertEquals(d.tables.notifications.length, 0)
    // with a claim of their own they are really on the receipt
    b.expense_item_claims.push(claimRow('l1', 'lou', 5, 'lou'))
    assert((await sendReceiptTableNotice(fakeAdmin(b).client, sender, T('lou'))).sent)
  }
})

Deno.test('table/reminder/result: an explicit participant list wins: a declined, cancelled or inactive person ON it is emailed; one not on it (or removed) is not', async () => {
  for (const patch of [{ active: false }, { confirmation_status: 'declined' }, { confirmation_status: 'cancelled' }]) {
    const b = base()
    Object.assign(b.trip_participants[2], patch) // lou
    b.expenses[0].participant_ids = ['marj', 'lou']
    const { sender, sent } = fakeSender()
    assert((await sendReceiptTableNotice(fakeAdmin(b).client, sender, T('lou'))).sent)
    assertEquals(sent.length, 1)
    const r = base()
    Object.assign(r.trip_participants[2], patch)
    r.expenses[0].participant_ids = ['marj'] // lou not on the explicit list
    assertEquals((await sendReceiptTableNotice(fakeAdmin(r).client, fakeSender().sender, T('lou'))).reason, 'not_on_receipt')
  }
  const removed = base()
  removed.expenses[0].participant_ids = ['marj', 'lou']
  removed.trip_participants = removed.trip_participants.filter((p) => p.user_id !== 'lou')
  assert(!(await sendReceiptTableNotice(fakeAdmin(removed).client, fakeSender().sender, T('lou'))).sent)
  const res = closedBase()
  res.trip_participants[1].active = false
  res.expenses[0].participant_ids = ['marj']
  assert((await sendReceiptResultNotice(fakeAdmin(res).client, fakeSender().sender, RES())).sent)
})

Deno.test('table: a failed send deletes the new link and restores the ones it retired; retries do not burn the resend cap', async () => {
  const b = { ...base(), receipt_claim_tokens: [1, 2, 3, 4, 5].map((i) => ({ id: `old${i}`, expense_id: 'e1', user_id: 'marj', used_at: null as string | null })) as Row[] }
  const d = fakeAdmin(b, (fn) => {
    // the real RPC inserts the new link and retires the oldest beyond five
    const rows = b.receipt_claim_tokens
    rows.push({ id: 'new', expense_id: 'e1', user_id: 'marj', used_at: null })
    rows[0].used_at = 'now'
    return { result: 'issued', token_id: 'new' }
  })
  const bad = fakeSender({ fail: true })
  for (let i = 0; i < 4; i++) assertEquals((await sendReceiptTableNotice(d.client, bad.sender, T())).reason, 'send_failed')
  assertEquals(d.tables.notifications.length, 0)
  assertEquals(d.tables.receipt_claim_tokens.map((r) => [r.id, r.used_at]), [1, 2, 3, 4, 5].map((i) => [`old${i}`, null]))
  assert((await sendReceiptTableNotice(d.client, fakeSender().sender, T())).sent)
})

Deno.test('table batch: a retry after a provider failure only sends to the people not yet told', async () => {
  const d = fakeAdmin(base())
  let n = 0
  const flaky: EmailSender = { channel: 'email', available: true, send: () => (++n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve({ provider: 't', providerMessageId: null })) }
  const first = await sendReceiptTableNotices(d.client, flaky, { expenseId: 'e1', userIds: ['marj', 'lou'], actorId: 'payer', appBaseUrl: APP })
  assertEquals(first.map((o) => o.reason), [null, 'send_failed'])
  const { sender, sent } = fakeSender()
  const second = await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj', 'lou'], actorId: 'payer', appBaseUrl: APP })
  assertEquals(second.map((o) => o.reason), ['already_sent', null])
  assertEquals(sent.map((m) => m.toEmail), ['l@x.co'])
})

Deno.test('result: never to inactive/declined people; wording follows the recipient; early close says so', async () => {
  const s = fakeSender()
  const gone = closedBase()
  gone.trip_participants[1].active = false
  assertEquals((await sendReceiptResultNotice(fakeAdmin(gone).client, s.sender, RES())).reason, 'not_on_receipt')
  const done = closedBase()
  done.expenses[0].claim_deadline = new Date(Date.now() - 3600_000).toISOString()
  done.expense_claim_responses.push({ expense_id: 'e1', user_id: 'marj', response: 'done' })
  assert((await sendReceiptResultNotice(fakeAdmin(done).client, s.sender, RES())).sent)
  assertStringIncludes(s.sent[0].text, "shared by everyone, including people who had said 'That's everything'")
  assertFalse(s.sent[0].text.includes('between people who had not said'))
  const late = closedBase()
  late.expenses[0].claim_deadline = new Date(Date.now() - 3600_000).toISOString()
  assert((await sendReceiptResultNotice(fakeAdmin(late).client, s.sender, RES())).sent)
  assertStringIncludes(s.sent[1].text, 'between people who had not said')
  assertStringIncludes(s.sent[1].text, 'The deadline passed')
  const early = closedBase()
  early.expenses[0].claims_closed_at = new Date(Date.now() - 1000).toISOString() // deadline is 3 days away
  assert((await sendReceiptResultNotice(fakeAdmin(early).client, s.sender, RES())).sent)
  assertStringIncludes(s.sent[2].text, 'The rest was shared early')
})

// --- review 2: resend, reopen, new deadline ----------------------------------------------------------------------

Deno.test('table: force (resend_user_ids) re-emails an unchanged person, still capped at 3 per receipt; others are not forced', async () => {
  const d = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  assert((await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj', 'lou'], actorId: 'payer', appBaseUrl: APP })).every((o) => o.sent))
  assertEquals(sent.length, 2)
  // unchanged items: a plain retry sends nothing, a forced resend sends to marj only
  const again = await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj', 'lou'], actorId: 'payer', appBaseUrl: APP, resendUserIds: ['marj'] })
  assertEquals(again.map((o) => o.sent), [true, false])
  assertEquals(again[1].reason, 'already_sent')
  assertEquals(sent.length, 3)
  assert(d.tables.notifications.some((r) => r.dedupe_key === 'notice:receipt:e1:marj:table:2'))
  assert((await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj'], actorId: 'payer', appBaseUrl: APP, resendUserIds: ['marj'] }))[0].sent)
  const capped = await sendReceiptTableNotices(d.client, sender, { expenseId: 'e1', userIds: ['marj'], actorId: 'payer', appBaseUrl: APP, resendUserIds: ['marj'] })
  assertEquals(capped[0].reason, 'capped')
  assertEquals(sent.length, 4)
  // gates still apply to a forced resend: answered people and opt-outs
  const g = base()
  g.expense_claim_responses = [{ expense_id: 'e1', user_id: 'lou', response: 'done' }]
  g.users[1].email_notifications_enabled = false
  const gd = fakeAdmin(g)
  const out = await sendReceiptTableNotices(gd.client, fakeSender().sender, { expenseId: 'e1', userIds: [], actorId: 'payer', appBaseUrl: APP, resendUserIds: ['marj', 'lou'] })
  assertEquals(out.map((o) => o.reason), ['opt_out', 'not_on_receipt'])
})

Deno.test('table: a link issued when the database answers claims_closed (the new spelling) is refused as closed', async () => {
  const d = fakeAdmin(base(), () => ({ result: 'claims_closed' }))
  assertEquals((await sendReceiptTableNotice(d.client, fakeSender().sender, T())).reason, 'closed')
  assertEquals(d.tables.notifications.length, 0)
})

Deno.test('reminder: once per deadline day, a moved deadline (reopen) gets one more, never beyond 2', async () => {
  const b = base()
  b.expenses[0].claim_deadline = soon()
  const d = fakeAdmin(b)
  const { sender, sent } = fakeSender()
  assert((await sendReceiptReminderNotice(d.client, sender, R())).sent)
  assertEquals((await sendReceiptReminderNotice(d.client, sender, R())).reason, 'already_sent')
  // reopened with a deadline 5 days on, reminder window again
  const later = new Date(Date.now() + 5 * 864e5)
  b.expenses[0].claim_deadline = new Date(later.getTime() + 3600_000).toISOString()
  const e = d.tables.expenses[0]
  const near = new Date(Date.now() + 20 * 3600_000 + 3 * 864e5) // a different UTC day than soon()
  e.claim_deadline = near.toISOString()
  // the window check needs the deadline within 25h: emulate "that day" by pretending now is 20h before it
  const now2 = new Date(near.getTime() - 20 * 3600_000)
  assert((await sendReceiptReminderNotice(d.client, sender, { ...R(), now: now2 })).sent)
  assertEquals(sent.length, 2)
  assertEquals(d.tables.notifications.filter((r) => r.kind === 'receipt_reminder').length, 2)
  const third = new Date(near.getTime() + 2 * 864e5)
  e.claim_deadline = third.toISOString()
  assertEquals((await sendReceiptReminderNotice(d.client, sender, { ...R(), now: new Date(third.getTime() - 20 * 3600_000) })).reason, 'capped')
})

Deno.test('reminder after a reopen: edits made before the reopen (rebuilt rows) do not count as "engaged"', async () => {
  const b = base()
  b.expenses[0].claim_deadline = soon()
  // marj's own claim row was touched when the reopen stripped leftovers
  const reopened = new Date(Date.now() - 1000).toISOString()
  b.expense_item_claims.push(claimRow('l1', 'lou', 5, 'lou', { updated_at: reopened }))
  b.activity_feed = [{ trip_id: 't1', verb: 'receipt_reopened', entity: { type: 'expense', id: 'e1' }, created_at: reopened }]
  const d = fakeAdmin(b)
  assert((await sendReceiptReminderNotice(d.client, fakeSender().sender, R('lou'))).sent)
  // without the reopen row the same state reads as engaged
  const b2 = base()
  b2.expenses[0].claim_deadline = soon()
  b2.expense_item_claims.push(claimRow('l1', 'lou', 5, 'lou', { updated_at: reopened }))
  assertEquals((await sendReceiptReminderNotice(fakeAdmin(b2).client, fakeSender().sender, R('lou'))).reason, 'engaged')
})

Deno.test('table-item shares are not "own claims" and not "own changes"', async () => {
  const b = base()
  b.expense_line_items.push({ id: 't1', expense_id: 'e1', line_number: 3, name_original: 'Bread', name_english: null, quantity: 1, total_amount: 6, shared_by_all: true } as Row)
  b.trip_participants[2].active = false // lou has left
  b.expense_item_claims = [claimRow('t1', 'lou', 2, 'lou')]
  const d = fakeAdmin(b)
  assertEquals((await sendReceiptTableNotice(d.client, fakeSender().sender, T('lou'))).reason, 'not_on_receipt')
})

Deno.test('result: after a reopen and a second close, one more notice only if the amount changed (cap 2)', async () => {
  const d = fakeAdmin(closedBase())
  const { sender, sent } = fakeSender()
  assert((await sendReceiptResultNotice(d.client, sender, RES())).sent) // first close: 300
  assertEquals((await sendReceiptResultNotice(d.client, sender, RES())).reason, 'already_sent') // re-closed, same amount
  assert((await sendReceiptResultNotice(d.client, sender, RES('marj', { leftoverAmountMinor: 450, totalMinor: 4650 }))).sent) // changed
  assert(d.tables.notifications.some((r) => r.dedupe_key === 'notice:receipt:e1:marj:result:450'))
  assertEquals((await sendReceiptResultNotice(d.client, sender, RES('marj', { leftoverAmountMinor: 100 }))).reason, 'capped')
  assertEquals(sent.length, 2)
})
