import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import type { EmailMessage, EmailSender } from './emailSender.ts'
import { sendConfirmedNotice, sendDisputedNotice, sendPaidNotice, type SupabaseClient } from './paymentNoticeSend.ts'

type Row = Record<string, unknown>

/** A tiny in-memory stand-in for the parts of supabase-js the senders use. */
function fakeAdmin(tables: Record<string, Row[]>, rpcResult: unknown = { result: 'issued' }) {
  const calls = { rpc: [] as Array<{ fn: string; args: unknown }> }
  const builder = (name: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'delete' = 'select'
    let head = false
    const run = () => {
      const rows = (tables[name] ??= [])
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      if (mode === 'delete') {
        tables[name] = rows.filter((r) => !hit.includes(r))
        return { data: null, error: null }
      }
      return head ? { data: null, error: null, count: hit.length } : { data: hit, error: null }
    }
    const b: Record<string, unknown> = {
      select: (_c?: string, opts?: { head?: boolean }) => {
        head = !!opts?.head
        return b
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      gte: (c: string, v: unknown) => (filters.push((r) => String(r[c]) >= String(v)), b),
      // PostgREST or(): "a.eq.1,b.eq.2"
      or: (expr: string) => {
        const parts = expr.split(',').map((p) => p.split('.eq.'))
        filters.push((r) => parts.some(([c, v]) => r[c] === v))
        return b
      },
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      delete: () => ((mode = 'delete'), b),
      maybeSingle: () => {
        const r = run()
        return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null })
      },
      insert: (row: Row) => {
        const rows = (tables[name] ??= [])
        if (name === 'notifications' && rows.some((r) => r.dedupe_key === row.dedupe_key)) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
        }
        rows.push(row)
        return Promise.resolve({ error: null })
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  const client = {
    from: (n: string) => builder(n),
    rpc: (fn: string, args: unknown) => {
      calls.rpc.push({ fn, args })
      return Promise.resolve({ data: rpcResult, error: null })
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

const base = () => ({
  settlements: [{ id: 's1', trip_id: 't1', from_user_id: 'payer', to_user_id: 'recv', amount: 105.11, currency: null, status: 'marked_paid', notes: 'Bank <transfer>' } as Row],
  trips: [{ id: 't1', name: 'Japow', base_currency: 'GBP', settlement_snapshot: null as unknown }],
  users: [
    { id: 'payer', email: 'p@x.co', full_name: 'Salim Khan', first_name: 'Salim', email_notifications_enabled: true },
    { id: 'recv', email: 'r@x.co', full_name: 'Tim Lam', first_name: 'Tim', email_notifications_enabled: true },
    { id: 'org', email: 'o@x.co', full_name: 'Olive Org', first_name: null, email_notifications_enabled: true },
  ],
  trip_participants: [
    { trip_id: 't1', user_id: 'payer', active: true },
    { trip_id: 't1', user_id: 'recv', active: true },
    { trip_id: 't1', user_id: 'org', active: true },
  ] as Row[],
  settlement_carryovers: [] as Row[],
  notifications: [] as Row[],
  activity_feed: [] as Row[],
})
const OPTS = { settlementId: 's1', appBaseUrl: 'https://trips.fontem.ai' }

Deno.test('paid notice: sends once to the receiver with a token link, writes dedupe + activity rows', async () => {
  const { client, tables, calls } = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  const r = await sendPaidNotice(client, sender, { ...OPTS, actorId: 'payer' })
  assertEquals(r, { sent: true, reason: null })
  assertEquals(sent.length, 1)
  assertEquals(sent[0].toEmail, 'r@x.co')
  assertEquals(sent[0].subject, 'Salim paid you £105.11 — Japow')
  assert(/confirm-payment\?t=[A-Za-z0-9_-]{43}/.test(sent[0].text))
  assert(sent[0].html!.includes('Bank &lt;transfer&gt;'))
  assertEquals(tables.notifications.length, 1)
  assertEquals(tables.notifications[0].dedupe_key, 'notice:paid:s1:recv:1')
  assertEquals(tables.notifications[0].kind, 'payment_paid_notice')
  assertEquals(tables.activity_feed[0].verb, 'settlement_receipt_requested')
  // Only the hash goes to the database, never the raw token.
  const args = calls.rpc[0].args as { p_token_hash: string }
  assertEquals(args.p_token_hash.length, 64)
  assertFalse(sent[0].text.includes(args.p_token_hash))
})

Deno.test('paid notice: a second (or concurrent) call sends nothing', async () => {
  const { client } = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  const [a, b] = await Promise.all([
    sendPaidNotice(client, sender, { ...OPTS, actorId: 'payer' }),
    sendPaidNotice(client, sender, { ...OPTS, actorId: 'payer' }),
  ])
  assertEquals(sent.length, 1)
  assertEquals([a.sent, b.sent].sort(), [false, true])
  const again = await sendPaidNotice(client, sender, { ...OPTS, actorId: 'payer' })
  assertEquals(again.reason, 'already_sent')
  assertEquals(sent.length, 1)
})

Deno.test('paid notice: recorded by an organiser says so', async () => {
  const { client } = fakeAdmin(base())
  const { sender, sent } = fakeSender()
  await sendPaidNotice(client, sender, { ...OPTS, actorId: 'org' })
  assert(sent[0].text.includes('Olive recorded that Salim paid you £105.11 for Japow.'))
})

Deno.test('paid notice: gates send nothing and leave no dedupe row', async () => {
  const cases: Array<[string, (d: ReturnType<typeof base>) => void, string, string?]> = [
    ['status confirmed', (d) => void (d.settlements[0].status = 'confirmed'), 'not_marked_paid'],
    ['status suggested', (d) => void (d.settlements[0].status = 'suggested'), 'not_marked_paid'],
    ['payer == receiver', (d) => void (d.settlements[0].to_user_id = 'payer'), 'same_person'],
    ['opt out', (d) => void (d.users[1].email_notifications_enabled = false), 'opt_out'],
    ['no email', (d) => void ((d.users[1] as Row).email = null), 'no_email'],
    ['receiver recorded it', () => {}, 'self_recorded', 'recv'],
  ]
  for (const [label, mutate, reason, actor] of cases) {
    const d = base()
    mutate(d)
    const { client, tables } = fakeAdmin(d)
    const { sender, sent } = fakeSender()
    const r = await sendPaidNotice(client, sender, { ...OPTS, actorId: actor ?? 'payer' })
    assertEquals(r.reason, reason, label)
    assertEquals(sent.length, 0, label)
    assertEquals(tables.notifications.length, 0, label)
  }
  const { client } = fakeAdmin(base())
  const none = fakeSender({ available: false })
  assertEquals((await sendPaidNotice(client, none.sender, { ...OPTS, actorId: 'payer' })).reason, 'no_channel')
  const gone = fakeAdmin({ ...base(), settlements: [] })
  assertEquals((await sendPaidNotice(gone.client, fakeSender().sender, { ...OPTS, actorId: 'payer' })).reason, 'not_found')
})

Deno.test('paid notice: a failed send releases the dedupe row so a retry can send', async () => {
  const d = fakeAdmin(base())
  const failing = fakeSender({ fail: true })
  const r = await sendPaidNotice(d.client, failing.sender, { ...OPTS, actorId: 'payer' })
  assertEquals(r.reason, 'send_failed')
  assertEquals(d.tables.notifications.length, 0)
  assertEquals(d.tables.activity_feed.length, 0)
  const ok = fakeSender()
  assert((await sendPaidNotice(d.client, ok.sender, { ...OPTS, actorId: 'payer' })).sent)
})

Deno.test('paid notice: no token issued (payment moved on) sends nothing and releases', async () => {
  const d = fakeAdmin(base(), { result: 'not_marked_paid' })
  const { sender, sent } = fakeSender()
  const r = await sendPaidNotice(d.client, sender, { ...OPTS, actorId: 'payer' })
  assertEquals(r.reason, 'token_failed')
  assertEquals(sent.length, 0)
  assertEquals(d.tables.notifications.length, 0)
})

Deno.test('confirmed notice: payer is told; square only on a frozen trip with nothing else to pay', async () => {
  const d = base()
  d.settlements[0].status = 'confirmed'
  d.trips[0].settlement_snapshot = { transactions: [] } as never
  const a = fakeAdmin(d)
  const s1 = fakeSender()
  assert((await sendConfirmedNotice(a.client, s1.sender, OPTS)).sent)
  assertEquals(s1.sent[0].toEmail, 'p@x.co')
  assertEquals(s1.sent[0].subject, 'Tim confirmed your £105.11 — Japow')
  assert(s1.sent[0].text.includes("you're square for Japow"))
  assertEquals(a.tables.notifications[0].dedupe_key, 'notice:confirmed:s1:payer:1')
  assertEquals((await sendConfirmedNotice(a.client, s1.sender, OPTS)).reason, 'already_sent')

  const d2 = base()
  d2.settlements[0].status = 'confirmed'
  d2.trips[0].settlement_snapshot = { transactions: [] } as never
  d2.settlements.push({ id: 's2', trip_id: 't1', from_user_id: 'payer', to_user_id: 'org', amount: 5, currency: 'GBP', status: 'suggested', notes: null })
  const b = fakeAdmin(d2)
  const s2 = fakeSender()
  await sendConfirmedNotice(b.client, s2.sender, OPTS)
  assertFalse(s2.sent[0].text.includes('square'))

  const d3 = base()
  d3.settlements[0].status = 'confirmed'
  const c = fakeAdmin(d3)
  const s3 = fakeSender()
  await sendConfirmedNotice(c.client, s3.sender, OPTS)
  assertFalse(s3.sent[0].text.includes('square'))
})

Deno.test('confirmed notice: not sent unless the payment is confirmed, or if the payer opted out', async () => {
  const a = fakeAdmin(base())
  assertEquals((await sendConfirmedNotice(a.client, fakeSender().sender, OPTS)).reason, 'not_confirmed')
  const d = base()
  d.settlements[0].status = 'confirmed'
  d.users[0].email_notifications_enabled = false
  const b = fakeAdmin(d)
  assertEquals((await sendConfirmedNotice(b.client, fakeSender().sender, OPTS)).reason, 'opt_out')
  assertEquals(b.tables.notifications.length, 0)
})

Deno.test('paid notice (M2): both people must be on the payment\'s trip', async () => {
  for (const gone of ['payer', 'recv']) {
    const d = base()
    d.trip_participants = d.trip_participants.filter((p) => p.user_id !== gone)
    const { client, tables } = fakeAdmin(d)
    const { sender, sent } = fakeSender()
    const r = await sendPaidNotice(client, sender, { ...OPTS, actorId: 'payer' })
    assertEquals(r, { sent: false, reason: 'not_found' }, gone)
    assertEquals(sent.length, 0)
    assertEquals(tables.notifications.length, 0)
  }
  // A participant who left (inactive) can still be owed.
  const d = base()
  d.trip_participants[1].active = false
  const { client } = fakeAdmin(d)
  assert((await sendPaidNotice(client, fakeSender().sender, { ...OPTS, actorId: 'payer' })).sent)
})

Deno.test('paid notice (M2): at most 10 per receiver per day, counted from notifications.sent_at', async () => {
  const old = new Date(Date.now() - 2 * 864e5).toISOString()
  const recent = new Date(Date.now() - 3600e3).toISOString()
  const mk = (n: number, at: string) => Array.from({ length: n }, (_, i) => ({ user_id: 'recv', kind: 'payment_paid_notice', sent_at: at, dedupe_key: `k${at}${i}` }) as Row)
  // 9 recent + 20 old: still allowed (old ones do not count)
  const a = base()
  a.notifications = [...mk(9, recent), ...mk(20, old)]
  const sa = fakeSender()
  assert((await sendPaidNotice(fakeAdmin(a).client, sa.sender, { ...OPTS, actorId: 'payer' })).sent)
  // 10 recent: capped, nothing sent, no new dedupe row
  const b = base()
  b.notifications = mk(10, recent)
  const f = fakeAdmin(b)
  const sb = fakeSender()
  const r = await sendPaidNotice(f.client, sb.sender, { ...OPTS, actorId: 'payer' })
  assertEquals(r, { sent: false, reason: 'capped' })
  assertEquals(sb.sent.length, 0)
  assertEquals(f.tables.notifications.length, 10)
  // other kinds / other people do not count
  const c = base()
  c.notifications = [...mk(10, recent).map((n) => ({ ...n, kind: 'payment_confirmed_notice' })), ...mk(10, recent).map((n, i) => ({ ...n, user_id: 'x', dedupe_key: 'z' + i }))]
  assert((await sendPaidNotice(fakeAdmin(c).client, fakeSender().sender, { ...OPTS, actorId: 'payer' })).sent)
})

Deno.test('confirmed notice (L11): square only with no carryover and nothing else unfinished for the payer', async () => {
  const frozen = () => {
    const d = base()
    d.settlements[0].status = 'confirmed'
    d.trips[0].settlement_snapshot = { transactions: [] } as never
    return d
  }
  const run = async (d: ReturnType<typeof base>) => {
    const s = fakeSender()
    await sendConfirmedNotice(fakeAdmin(d).client, s.sender, OPTS)
    return s.sent[0].text
  }
  assert((await run(frozen())).includes("you're square"))
  const c1 = frozen()
  c1.settlement_carryovers = [{ trip_id: 't1', source_trip_id: 't0', from_user_id: 'payer', to_user_id: 'org' }]
  assertFalse((await run(c1)).includes('square'))
  const c2 = frozen()
  c2.settlement_carryovers = [{ trip_id: 't9', source_trip_id: 't1', from_user_id: 'org', to_user_id: 'payer' }]
  assertFalse((await run(c2)).includes('square'))
  const c3 = frozen() // a carryover for someone else only does not matter
  c3.settlement_carryovers = [{ trip_id: 't1', source_trip_id: 't0', from_user_id: 'org', to_user_id: 'recv' }]
  assert((await run(c3)).includes("you're square"))
  const c4 = frozen() // an unfinished payment owed TO the payer also blocks "square"
  c4.settlements.push({ id: 's9', trip_id: 't1', from_user_id: 'org', to_user_id: 'payer', amount: 3, currency: 'GBP', status: 'suggested', notes: null })
  assertFalse((await run(c4)).includes('square'))
})

Deno.test('disputed notice: payer is told once, only while the payment is still marked paid', async () => {
  const a = fakeAdmin(base())
  const s = fakeSender()
  const r = await sendDisputedNotice(a.client, s.sender, OPTS)
  assertEquals(r, { sent: true, reason: null })
  assertEquals(s.sent[0].toEmail, 'p@x.co')
  assertEquals(s.sent[0].subject, "Tim says they haven't received your £105.11 yet")
  assertEquals(a.tables.notifications[0].dedupe_key, 'notice:disputed:s1:payer:1')
  assertEquals(a.tables.notifications[0].kind, 'payment_disputed_notice')
  assertEquals((await sendDisputedNotice(a.client, s.sender, OPTS)).reason, 'already_sent')
  assertEquals(s.sent.length, 1)

  const d = base()
  d.settlements[0].status = 'confirmed'
  assertEquals((await sendDisputedNotice(fakeAdmin(d).client, fakeSender().sender, OPTS)).reason, 'not_marked_paid')
  const o = base()
  o.users[0].email_notifications_enabled = false
  assertEquals((await sendDisputedNotice(fakeAdmin(o).client, fakeSender().sender, OPTS)).reason, 'opt_out')
  const n = base()
  n.trip_participants = n.trip_participants.filter((p) => p.user_id !== 'payer')
  assertEquals((await sendDisputedNotice(fakeAdmin(n).client, fakeSender().sender, OPTS)).reason, 'not_found')
  const f = fakeAdmin(base())
  assertEquals((await sendDisputedNotice(f.client, fakeSender({ fail: true }).sender, OPTS)).reason, 'send_failed')
  assertEquals(f.tables.notifications.length, 0) // released so a retry can send
})
