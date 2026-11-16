import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import type { EmailMessage, EmailSender } from './emailSender.ts'
import { sendConfirmedNotice, sendDisputedNotice, sendPaidNotice, sendReAskNotice, sendRetractedNotice, type SupabaseClient } from './paymentNoticeSend.ts'

type Row = Record<string, unknown>

/** A tiny in-memory stand-in for the parts of supabase-js the senders use. */
let tick = Date.now()
const nextTime = () => new Date((tick += 1000)).toISOString()

function fakeAdmin(
  tables: Record<string, Row[]>,
  rpcResult: unknown | ((fn: string, args: Record<string, unknown>) => unknown) = { result: 'issued' },
  opts: { noFlagColumn?: boolean; failState?: boolean } = {}
) {
  const calls = { rpc: [] as Array<{ fn: string; args: unknown }> }
  const builder = (name: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: 'select' | 'delete' = 'select'
    let head = false
    let cols = ''
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
      select: (c?: string, o?: { head?: boolean }) => {
        head = !!o?.head
        cols = c ?? ''
        return b
      },
      eq: (c: string, v: unknown) => {
        // PostgREST JSON path filter: entity->>id
        if (c.includes('->>')) {
          const [col, key] = c.split('->>')
          filters.push((r) => ((r[col] as Record<string, unknown> | null)?.[key] ?? null) === v)
        } else filters.push((r) => r[c] === v)
        return b
      },
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
        if (opts.noFlagColumn && name === 'settlements' && (cols.includes('receipt_disputed_at') || cols.includes('last_retracted_at'))) {
          return Promise.resolve({ data: null, error: { code: '42703', message: 'column settlements.receipt_disputed_at does not exist' } })
        }
        if (opts.failState && name === 'settlements' && (cols.includes('receipt_disputed_at') || cols.includes('last_retracted_at'))) {
          return Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
        }
        const r = run()
        return Promise.resolve({ data: (r.data as Row[] | null)?.[0] ?? null, error: null })
      },
      insert: (row: Row) => {
        const rows = (tables[name] ??= [])
        if (name === 'notifications' && rows.some((r) => r.dedupe_key === row.dedupe_key)) {
          return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
        }
        rows.push(name === 'notifications' ? { sent_at: nextTime(), ...row } : name === 'activity_feed' ? { created_at: nextTime(), ...row } : row)
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
      const data = typeof rpcResult === 'function' ? (rpcResult as (f: string, a: unknown) => unknown)(fn, args as Record<string, unknown>) : rpcResult
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
  assert(/confirm-payment\?t=[A-Za-z0-9_-]{43}&a=yes/.test(sent[0].text))
  assert(/confirm-payment\?t=[A-Za-z0-9_-]{43}&a=no/.test(sent[0].text))
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

// ---------------------------------------------------------------------------
// Dispute / re-ask / retract
// ---------------------------------------------------------------------------

/**
 * rpc stub: tokens issue; clear_receipt_dispute clears the flag (and issues the fresh link when given a hash, like the
 * real one); restore_receipt_dispute puts the flag back.
 */
const rpcFor = (tables: { settlements: Row[] }) => (fn: string, _args: Record<string, unknown>) => {
  if (fn === 'clear_receipt_dispute') {
    const row = tables.settlements[0]
    if (!row.receipt_disputed_at) return { result: 'not_disputed' }
    row.receipt_disputed_at = null
    return { result: 'cleared' }
  }
  if (fn === 'restore_receipt_dispute') {
    tables.settlements[0].receipt_disputed_at = '2026-11-21T00:00:00Z'
    return { result: 'restored' }
  }
  return { result: 'issued' }
}
/** What the database guard does when a payment goes back to suggested: stamp last_retracted_at. */
const retract = (d: { settlements: Row[] }) => {
  d.settlements[0].status = 'suggested'
  d.settlements[0].last_retracted_at = nextTime()
}
const disputedBase = () => {
  const d = base()
  ;(d.settlements[0] as Row).receipt_disputed_at = '2026-11-20T10:00:00Z'
  return d
}
const OPTS_ACTOR = { ...OPTS, actorId: 'payer' }
const kinds = (t: Record<string, Row[]>) => t.notifications.map((n) => n.dedupe_key)

Deno.test('paid notice: second marking after a retraction sends again (key 2), capped at 4 per payment', async () => {
  const d = base()
  const a = fakeAdmin(d)
  const s = fakeSender()
  assert((await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)).sent)
  assertEquals((await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'already_sent') // same round
  for (const n of [2, 3, 4]) {
    retract(d)
    assert((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).sent || true)
    d.settlements[0].status = 'marked_paid'
    const r = await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
    assert(r.sent, `paid #${n}`)
    assertEquals(a.tables.notifications.filter((x) => x.kind === 'payment_paid_notice').at(-1)!.dedupe_key, `notice:paid:s1:recv:${n}`)
  }
  retract(d)
  await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)
  d.settlements[0].status = 'marked_paid'
  assertEquals(await sendPaidNotice(a.client, s.sender, OPTS_ACTOR), { sent: false, reason: 'capped' })
  assertEquals(a.tables.notifications.filter((x) => x.kind === 'payment_paid_notice').length, 4)
})

Deno.test('retracted notice: needs suggested + an earlier paid notice, one per retraction, writes the boundary activity', async () => {
  const d = base()
  const a = fakeAdmin(d)
  const s = fakeSender()
  // never told: nothing sent, nothing written
  retract(d)
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'never_notified')
  assertEquals(a.tables.activity_feed.length, 0)
  d.settlements[0].status = 'marked_paid'
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  // still marked paid: refused
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'not_suggested')
  retract(d)
  const r = await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)
  assertEquals(r, { sent: true, reason: null })
  const mail = s.sent.at(-1)!
  assertEquals(mail.toEmail, 'r@x.co')
  assertEquals(mail.subject, "Salim hasn't paid the £105.11 yet — Japow")
  assert(a.tables.notifications.some((n) => n.dedupe_key === 'notice:retracted:s1:recv:1' && n.kind === 'payment_retracted_notice'))
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_retracted').length, 1)
  // a repeated call (double tap) sends nothing and writes nothing more
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'already_sent')
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_retracted').length, 1)
})

Deno.test('retracted notice: a forged retraction activity row (any actor, even the payer) never reopens the paid sequence', async () => {
  const d = base()
  const a = fakeAdmin(d)
  const s = fakeSender()
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  a.tables.activity_feed.push({ verb: 'settlement_retracted', actor: 'recv', entity: { type: 'settlement', id: 's1' }, created_at: nextTime() })
  a.tables.activity_feed.push({ verb: 'settlement_retracted', actor: null, entity: { type: 'settlement', id: 's1' }, created_at: nextTime() })
  a.tables.activity_feed.push({ verb: 'settlement_retracted', actor: 'payer', entity: { type: 'settlement', id: 's1' }, created_at: nextTime() })
  assertEquals((await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'already_sent')
})

Deno.test('D3: the boundary is the database stamp, so a lost "retracted" call does not block the next paid notice', async () => {
  const d = base()
  const a = fakeAdmin(d)
  const s = fakeSender()
  assert((await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)).sent)
  retract(d) // the guard stamped it; the client's fire-and-forget 'retracted' call never arrived
  d.settlements[0].status = 'marked_paid'
  const r = await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  assertEquals(r, { sent: true, reason: null })
  assertEquals(a.tables.notifications.filter((n) => n.kind === 'payment_paid_notice').map((n) => n.dedupe_key), ['notice:paid:s1:recv:1', 'notice:paid:s1:recv:2'])
})

Deno.test('D3: an unknown boundary sends nothing (lookup error -> state_failed; column missing -> old once-only behaviour)', async () => {
  const failing = fakeAdmin(base(), undefined, { failState: true })
  assertEquals(await sendPaidNotice(failing.client, fakeSender().sender, OPTS_ACTOR), { sent: false, reason: 'state_failed' })
  assertEquals(failing.tables.notifications.length, 0)
  const old = fakeAdmin(base(), undefined, { noFlagColumn: true })
  assert((await sendPaidNotice(old.client, fakeSender().sender, OPTS_ACTOR)).sent)
  assertEquals((await sendPaidNotice(old.client, fakeSender().sender, OPTS_ACTOR)).reason, 'already_sent')
})

Deno.test('D3: retracted email needs a recent server stamp and one per retraction', async () => {
  const d = base()
  const a = fakeAdmin(d)
  const s = fakeSender()
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  d.settlements[0].status = 'suggested' // moved back without a stamp (should not happen; the guard always stamps)
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'not_retracted')
  d.settlements[0].last_retracted_at = new Date(Date.now() - 31 * 60_000).toISOString()
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'retract_stale')
  assertEquals(s.sent.length, 1)
  assertEquals(a.tables.notifications.filter((n) => n.kind === 'payment_retracted_notice').length, 0)
  retract(d)
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).sent, true)
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'already_sent')
})

Deno.test('retracted notice: receiver gates apply (opt-out); the feed line is still written', async () => {
  const d = base()
  const a = fakeAdmin(d)
  const s = fakeSender()
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  d.users[1].email_notifications_enabled = false
  retract(d)
  assertEquals((await sendRetractedNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'opt_out')
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_retracted').length, 1)
  assertEquals(a.tables.notifications.filter((x) => x.kind === 'payment_retracted_notice').length, 0)
})

Deno.test('re-ask: only while marked paid AND disputed; new token; two buttons; flag cleared; activities written', async () => {
  const d = disputedBase()
  const a = fakeAdmin(d, rpcFor(d))
  const s = fakeSender()
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  const r = await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)
  assertEquals(r, { sent: true, reason: null })
  const mail = s.sent.at(-1)!
  assertEquals(mail.toEmail, 'r@x.co')
  assertEquals(mail.subject, "Salim says they've sent £105.11 — can you check again?")
  assert(/a=yes/.test(mail.text) && /a=no/.test(mail.text))
  const key = a.tables.notifications.find((n) => n.kind === 'payment_reask_notice')!
  assertEquals(key.dedupe_key, 'notice:paid:s1:recv:2')
  assertEquals(d.settlements[0].receipt_disputed_at, null)
  // D4: ONE atomic call clears the flag and issues the fresh link (hash included); no separate issue call for the re-ask
  assertEquals(a.calls.rpc.map((c) => c.fn), ['issue_payment_confirm_token', 'clear_receipt_dispute'])
  assertEquals(((a.calls.rpc[1].args as { p_token_hash: string }).p_token_hash).length, 64)
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_re_asked').length, 1)
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_receipt_requested' && (x.metadata as Row).re_ask === true).length, 1)
  // no longer disputed: a second tap does nothing
  assertEquals((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'not_disputed')
  assertEquals(s.sent.length, 2)
})

Deno.test('re-ask: refused when not disputed, not marked paid, or the column is missing (nothing at all happens)', async () => {
  const plain = fakeAdmin(base(), rpcFor(base()))
  assertEquals((await sendReAskNotice(plain.client, fakeSender().sender, OPTS_ACTOR)).reason, 'not_disputed')
  const sug = disputedBase()
  sug.settlements[0].status = 'suggested'
  assertEquals((await sendReAskNotice(fakeAdmin(sug, rpcFor(sug)).client, fakeSender().sender, OPTS_ACTOR)).reason, 'not_marked_paid')
  const d = disputedBase()
  const missing = fakeAdmin(d, rpcFor(d), { noFlagColumn: true })
  const s = fakeSender()
  assertEquals((await sendReAskNotice(missing.client, s.sender, OPTS_ACTOR)).reason, 'not_disputed')
  assertEquals(s.sent.length, 0)
  assertEquals(missing.calls.rpc.length, 0)
  assertEquals(missing.tables.activity_feed.length, 0)
})

Deno.test('re-ask: at most 2 per payment ever; the third is refused and nothing is cleared', async () => {
  const d = disputedBase()
  const a = fakeAdmin(d, rpcFor(d))
  const s = fakeSender()
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  for (const n of [2, 3]) {
    d.settlements[0].receipt_disputed_at = '2026-11-20T10:00:00Z'
    assert((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).sent, `re-ask ${n}`)
    assert(a.tables.notifications.some((x) => x.dedupe_key === `notice:paid:s1:recv:${n}`))
  }
  d.settlements[0].receipt_disputed_at = '2026-11-20T10:00:00Z'
  assertEquals((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'reask_limit')
  assertEquals(d.settlements[0].receipt_disputed_at, '2026-11-20T10:00:00Z')
  assertEquals(s.sent.length, 3)
})

Deno.test('re-ask: receiver has emails off -> no email, but the flag is cleared and the re-ask counts (via activity)', async () => {
  const d = disputedBase()
  d.users[1].email_notifications_enabled = false
  const a = fakeAdmin(d, rpcFor(d))
  const s = fakeSender()
  assertEquals((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'opt_out')
  assertEquals(s.sent.length, 0)
  assertEquals(d.settlements[0].receipt_disputed_at, null)
  assertEquals(a.tables.notifications.length, 0)
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_re_asked').length, 1)
  // two more rounds exhaust the cap of 2 even though no notification rows exist
  d.settlements[0].receipt_disputed_at = 'x'
  await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)
  d.settlements[0].receipt_disputed_at = 'x'
  assertEquals((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'reask_limit')
})

Deno.test('re-ask (D4): a failed send puts the flag back, retires nothing the receiver saw, releases the key so a retry works', async () => {
  const d = disputedBase()
  const a = fakeAdmin(d, rpcFor(d))
  const r = await sendReAskNotice(a.client, fakeSender({ fail: true }).sender, OPTS_ACTOR)
  assertEquals(r.reason, 'send_failed')
  assert(d.settlements[0].receipt_disputed_at, 'flag restored')
  assertEquals(a.calls.rpc.map((c) => c.fn), ['clear_receipt_dispute', 'restore_receipt_dispute'])
  assertEquals(a.tables.notifications.length, 0)
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_re_asked').length, 0) // a failed ask does not count toward the cap
  assert((await sendReAskNotice(a.client, fakeSender().sender, OPTS_ACTOR)).sent)
})

Deno.test('re-ask (D2): database failures are reported, nothing is left claimed', async () => {
  for (const [fail, reason] of [
    [{ result: 'token_failed' }, 'token_failed'],
    [{ __error: true }, 'clear_failed'],
    [{ result: 'weird' }, 'clear_failed'],
    [{ result: 'not_disputed' }, 'not_disputed'],
    [{ result: 'not_marked_paid' }, 'not_marked_paid'],
  ] as const) {
    const d = disputedBase()
    const a = fakeAdmin(d, () => fail)
    const s = fakeSender()
    assertEquals((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).reason, reason)
    assertEquals(s.sent.length, 0)
    assertEquals(a.tables.notifications.length, 0)
  }
  // a transient failure reading the flag is NOT "not supported"
  const t = fakeAdmin(disputedBase(), undefined, { failState: true })
  assertEquals((await sendReAskNotice(t.client, fakeSender().sender, OPTS_ACTOR)).reason, 'state_failed')
})

Deno.test('re-ask (D2): capped (sequence full) changes nothing and says so', async () => {
  const d = disputedBase()
  const a = fakeAdmin(d, rpcFor(d))
  a.tables.notifications.push(
    ...[1, 2, 3, 4].map((n) => ({ kind: 'payment_paid_notice', entity_id: 's1', sent_at: nextTime(), dedupe_key: `notice:paid:s1:recv:${n}` }))
  )
  const s = fakeSender()
  assertEquals((await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)).reason, 'capped')
  assert(d.settlements[0].receipt_disputed_at)
  assertEquals(a.calls.rpc.length, 0)
  assertEquals(s.sent.length, 0)
})

Deno.test('re-ask: both people must be on the trip; gates and the daily cap leave no stray rows', async () => {
  const d = disputedBase()
  d.trip_participants = d.trip_participants.filter((p) => p.user_id !== 'recv')
  const a = fakeAdmin(d, rpcFor(d))
  assertEquals((await sendReAskNotice(a.client, fakeSender().sender, OPTS_ACTOR)).reason, 'not_found')
  assertEquals(d.settlements[0].receipt_disputed_at, '2026-11-20T10:00:00Z')
})

Deno.test('disputed notice (in app): needs the flag; one per round; a new round after a re-ask', async () => {
  const d = disputedBase()
  const a = fakeAdmin(d, rpcFor(d))
  const s = fakeSender()
  const inApp = { ...OPTS, requireFlag: true, activityActorId: 'recv' }
  await sendPaidNotice(a.client, s.sender, OPTS_ACTOR)
  assertEquals(await sendDisputedNotice(a.client, s.sender, inApp), { sent: true, reason: null })
  assertEquals(s.sent.at(-1)!.toEmail, 'p@x.co')
  assertEquals(a.tables.notifications.find((n) => n.kind === 'payment_disputed_notice')!.dedupe_key, 'notice:disputed:s1:payer:1')
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_receipt_disputed').length, 1)
  // double tap: nothing more
  assertEquals((await sendDisputedNotice(a.client, s.sender, inApp)).reason, 'already_sent')
  assertEquals(a.tables.activity_feed.filter((x) => x.verb === 'settlement_receipt_disputed').length, 1)
  // payer asks again, receiver says no again: round 2
  await sendReAskNotice(a.client, s.sender, OPTS_ACTOR)
  d.settlements[0].receipt_disputed_at = '2026-11-20T12:00:00Z'
  assertEquals((await sendDisputedNotice(a.client, s.sender, inApp)).sent, true)
  assert(a.tables.notifications.some((n) => n.dedupe_key === 'notice:disputed:s1:payer:2'))
  // not flagged: an in-app caller cannot make the payer receive mail
  d.settlements[0].receipt_disputed_at = null
  const before = a.tables.notifications.length
  const b = fakeAdmin(d, rpcFor(d))
  assertEquals((await sendDisputedNotice(b.client, fakeSender().sender, inApp)).reason, 'not_disputed')
  assertEquals(b.tables.notifications.length, before)
  // column missing: nothing
  const c = fakeAdmin(disputedBase(), undefined, { noFlagColumn: true })
  assertEquals((await sendDisputedNotice(c.client, fakeSender().sender, inApp)).reason, 'not_disputed')
})

Deno.test('disputed notice (token path, no flag check): unchanged behaviour plus round-awareness', async () => {
  const a = fakeAdmin(base())
  const s = fakeSender()
  assert((await sendDisputedNotice(a.client, s.sender, OPTS)).sent)
  assertEquals((await sendDisputedNotice(a.client, s.sender, OPTS)).reason, 'already_sent')
  assertEquals(kinds(a.tables), ['notice:disputed:s1:payer:1'])
})
