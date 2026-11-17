import { assertEquals } from 'jsr:@std/assert@1'
import {
  isMissingColumnOrTable, isMissingFunction, isPermanentApplyRefusal, isUnclaimedChaseRetired, reminderRecipients, resultRecipients, resultRecoveryRecipients,
  selectApplyCandidates, selectRecentlyClosed, selectReminderCandidates, type ReceiptRow,
} from './receiptPasses.ts'
import { runReceiptPasses } from './receiptPassesRun.ts'
import { createReceiptSenders, type ReceiptNoticeSenders, type SharedSenders } from './receiptSenders.ts'
import type { EmailSender } from '../_shared/emailSender.ts'

const now = new Date('2026-11-20T12:00:00Z')
const hrs = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString()
const row = (o: Partial<ReceiptRow> & { trip?: Record<string, unknown> } = {}): ReceiptRow => {
  const { trip, ...rest } = o
  return {
    id: 'e1', trip_id: 't1', paid_by: 'payer', currency: 'GBP', claims_sent_at: hrs(-30), claims_closed_at: null, claim_deadline: hrs(10),
    trips: { name: 'T', settlement_snapshot: null, receipt_notices_enabled: true, chase_settings: null, ...trip }, ...rest,
  }
}

Deno.test('reminder window: (now, now+24h] only; passed deadlines go to apply, never a reminder', () => {
  const rows = [row({ id: 'in', claim_deadline: hrs(10) }), row({ id: 'edge', claim_deadline: hrs(24) }), row({ id: 'far', claim_deadline: hrs(24.1) }),
    row({ id: 'past', claim_deadline: hrs(-1) }), row({ id: 'now', claim_deadline: hrs(0) })]
  assertEquals(selectReminderCandidates(rows, now).map((r) => r.id), ['in', 'edge'])
  assertEquals(selectApplyCandidates(rows, now).map((r) => r.id), ['past', 'now'])
})

Deno.test('first-run restraint: receipts without claims_sent_at are never reminded or applied', () => {
  const rows = [row({ claims_sent_at: null, claim_deadline: hrs(10) }), row({ claims_sent_at: null, claim_deadline: hrs(-50) })]
  assertEquals(selectReminderCandidates(rows, now), [])
  assertEquals(selectApplyCandidates(rows, now), [])
})

Deno.test('closed, frozen and deadline-less receipts are skipped; reminders obey receipt_notices_enabled, apply does not; chase_settings.enabled is irrelevant', () => {
  const closed = row({ claims_closed_at: hrs(-1), claim_deadline: hrs(-5) })
  const frozen = row({ claim_deadline: hrs(-5), trip: { settlement_snapshot: { x: 1 } } })
  const none = row({ claim_deadline: null })
  assertEquals(selectApplyCandidates([closed, frozen, none], now), [])
  const off = row({ claim_deadline: hrs(5), trip: { receipt_notices_enabled: false, chase_settings: { enabled: true } } })
  assertEquals(selectReminderCandidates([off], now), [])
  const offPast = row({ claim_deadline: hrs(-5), trip: { receipt_notices_enabled: false } })
  assertEquals(selectApplyCandidates([offPast], now).length, 1)
  const switchOff = row({ claim_deadline: hrs(5), trip: { chase_settings: { enabled: false } } })
  assertEquals(selectReminderCandidates([switchOff], now).length, 1)
})

Deno.test('reminder recipients: drops responders, payer and recent table-notice; only ever shrinks', () => {
  const tagged = ['payer', 'a', 'b', 'c', 'a']
  assertEquals(reminderRecipients({ tagged, payerId: 'payer', responded: new Set(['b']), recentTableNotice: new Set(['c']) }), ['a'])
  const all = reminderRecipients({ tagged, payerId: 'payer', responded: new Set(), recentTableNotice: new Set() })
  assertEquals(all.every((u) => tagged.includes(u)), true)
})

Deno.test('result recipients: only people charged, only when applied now', () => {
  const people = [{ user_id: 'a', amount: 5 }, { user_id: 'b', amount: 0 }, { user_id: 'c', amount: 2 }]
  assertEquals(resultRecipients({ applied: true, people }).map((p) => p.userId), ['a', 'c'])
  assertEquals(resultRecipients({ applied: true, people, notify_user_ids: ['c'] }).map((p) => p.userId), ['c'])
  assertEquals(resultRecipients({ applied: false, already_applied: true, people }), [])
  assertEquals(resultRecipients({ applied: true, people, notices_enabled: false }), [])
})

Deno.test('digest kind unclaimed_items: retired only for sent receipts (never adds recipients)', () => {
  assertEquals(isUnclaimedChaseRetired({ claims_sent_at: hrs(-1) }), true)
  assertEquals(isUnclaimedChaseRetired({ claims_sent_at: null }), false)
  assertEquals(isUnclaimedChaseRetired({}), false)
  const exps = [{ id: 1, claims_sent_at: 'x' }, { id: 2, claims_sent_at: null }, { id: 3 }]
  const kept = exps.filter((e) => !isUnclaimedChaseRetired(e))
  assertEquals(kept.every((e) => exps.includes(e)), true)
  assertEquals(kept.map((e) => e.id), [2, 3])
})

Deno.test('fail-soft detectors', () => {
  assertEquals(isMissingFunction({ code: 'PGRST202' }), true)
  assertEquals(isMissingFunction({ message: 'function public.apply_receipt_deadline(uuid) does not exist' }), true)
  assertEquals(isMissingFunction({ code: 'P0001', message: 'frozen' }), false)
  assertEquals(isMissingColumnOrTable({ code: '42703' }), true)
  assertEquals(isMissingColumnOrTable({ code: 'PGRST205' }), true)
  assertEquals(isMissingColumnOrTable({ code: '57014' }), false)
})

// ---- runner with a fake client ----
interface Fake {
  admin: unknown
  rpcCalls: string[]
}
function fakeAdmin(opts: {
  rows?: ReceiptRow[]; selectError?: { code: string; message: string }
  tagged?: string[]; responded?: string[]; recentTable?: string[]
  apply?: (id: string) => { data?: unknown; error?: unknown }
  closedRows?: ReceiptRow[]; claims?: Array<{ user_id: string; leftover_amount: number; amount_owed: number }>; told?: string[]; toldMinor?: number
}): Fake {
  const rpcCalls: string[] = []
  const q = (table: string) => {
    const b: Record<string, unknown> = {}
    const chain = () => b
    let closedQuery = false
    for (const m of ['is', 'eq', 'in', 'gte']) b[m] = chain
    b.not = (c: string) => { if (c === 'claims_closed_at') closedQuery = true; return b }
    b.select = chain
    b.then = (res: (v: unknown) => void) => {
      if (table === 'expenses') return res(opts.selectError ? { data: null, error: opts.selectError } : { data: closedQuery ? (opts.closedRows ?? []) : (opts.rows ?? []), error: null })
      if (table === 'expense_item_claims') return res({ data: opts.claims ?? [], error: null })
      if (table === 'notifications' && closedQuery === false && opts.told) return res({ data: opts.told.map((user_id) => ({ user_id, dedupe_key: `notice:receipt:e1:${user_id}:result:${opts.toldMinor ?? 400}`, sent_at: '2026-11-19T00:00:00Z' })), error: null })
      if (table === 'expense_claim_responses') return res({ data: (opts.responded ?? []).map((user_id) => ({ user_id })), error: null })
      if (table === 'notifications') return res({ data: (opts.recentTable ?? []).map((user_id) => ({ user_id })), error: null })
      return res({ data: [], error: null })
    }
    return b
  }
  return {
    rpcCalls,
    admin: {
      from: q,
      rpc: (fn: string, args: { p_expense_id: string }) => {
        rpcCalls.push(`${fn}:${args.p_expense_id}`)
        if (fn === '_receipt_tagged') return Promise.resolve({ data: opts.tagged ?? [], error: null })
        const r = opts.apply?.(args.p_expense_id) ?? { data: null, error: { code: 'PGRST202', message: 'x' } }
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null })
      },
    },
  }
}
function senders() {
  const log = { reminders: [] as string[], results: [] as Array<[string, number]> }
  const s: ReceiptNoticeSenders = {
    sendReceiptReminderNotice: (a) => { log.reminders.push(`${a.expenseId}:${a.userId}`); return Promise.resolve({ sent: true }) },
    sendReceiptResultNotice: (a) => { log.results.push([a.userId, a.amount]); return Promise.resolve({ sent: true }) },
  }
  return { s, log }
}

Deno.test('runner: no senders (no email provider) -> deadlines are still applied, nothing is emailed', async () => {
  const f = fakeAdmin({ rows: [row({ claim_deadline: hrs(-1) })], apply: () => ({ data: { applied: true, people: [{ user_id: 'a', amount: 4 }] } }) })
  const sum = await runReceiptPasses(f.admin, now, null)
  assertEquals(sum.receipt_senders_available, false)
  assertEquals(f.rpcCalls, ['apply_receipt_deadline:e1'])
  assertEquals(sum.applied, 1)
  assertEquals(sum.result_notices_sent, 0)
})

Deno.test('runner: reminders go to tagged non-responders only; trip reminder switch off does not matter', async () => {
  const f = fakeAdmin({ rows: [row({ claim_deadline: hrs(5), trip: { chase_settings: { enabled: false } } })], tagged: ['payer', 'a', 'b', 'c'], responded: ['b'], recentTable: ['c'] })
  const { s, log } = senders()
  const sum = await runReceiptPasses(f.admin, now, s)
  assertEquals(log.reminders, ['e1:a'])
  assertEquals(sum.reminders_sent, 1)
  assertEquals(f.rpcCalls.includes('apply_receipt_deadline:e1'), false)
})

const closedRow = (o: Partial<ReceiptRow> & { trip?: Record<string, unknown> } = {}) => row({ claim_deadline: hrs(-2), claims_closed_at: hrs(-1), ...o })
const claims = [
  { user_id: 'a', leftover_amount: 4, amount_owed: 14 }, { user_id: 'z', leftover_amount: 0, amount_owed: 9 },
  { user_id: 'payer', leftover_amount: 2, amount_owed: 20 },
]

Deno.test('runner: result notices go to people charged a leftover on receipts closed in the last 7 days (never the payer, never twice)', async () => {
  const f = fakeAdmin({ rows: [], closedRows: [closedRow()], claims })
  const { s, log } = senders()
  const sum = await runReceiptPasses(f.admin, now, s)
  assertEquals(log.results, [['a', 4]])
  assertEquals(sum.result_notices_sent, 1)
  assertEquals(log.reminders, [])
  // already has its result row: nothing more
  const g = fakeAdmin({ rows: [], closedRows: [closedRow()], claims, told: ['a'] })
  const { s: s2, log: log2 } = senders()
  await runReceiptPasses(g.admin, now, s2)
  assertEquals(log2.results, [])
  // reopened and re-closed with a DIFFERENT amount (4.00 -> told 3.00 before): one more notice; same amount: none
  const changed = fakeAdmin({ rows: [], closedRows: [closedRow()], claims, told: ['a'], toldMinor: 300 })
  const { s: s4, log: log4 } = senders()
  await runReceiptPasses(changed.admin, now, s4)
  assertEquals(log4.results, [['a', 4]])
  // closed 8 days ago: out of the window; notices off for the trip: nothing
  const old = fakeAdmin({ rows: [], closedRows: [closedRow({ claims_closed_at: hrs(-8 * 24) }), closedRow({ id: 'e2', trip: { receipt_notices_enabled: false } })], claims })
  const { s: s3, log: log3 } = senders()
  await runReceiptPasses(old.admin, now, s3)
  assertEquals(log3.results, [])
})

Deno.test('runner: a result notice that failed is retried on the next run; quiet hours hold neither the emails nor the apply', async () => {
  let fail = true
  const flaky: ReceiptNoticeSenders = {
    sendReceiptReminderNotice: () => Promise.resolve({ sent: false }),
    sendReceiptResultNotice: () => Promise.resolve(fail ? { sent: false, reason: 'send_failed' } : { sent: true }),
  }
  const f = fakeAdmin({ rows: [], closedRows: [closedRow()], claims })
  assertEquals((await runReceiptPasses(f.admin, now, flaky)).result_notices_sent, 0)
  fail = false
  assertEquals((await runReceiptPasses(f.admin, now, flaky)).result_notices_sent, 1)
  const quiet = { chase_settings: { quiet_hours: { start: 10, end: 14 } } }
  const q = fakeAdmin({ rows: [row({ claim_deadline: hrs(-1), trip: quiet })], closedRows: [closedRow({ trip: quiet })], claims, apply: () => ({ data: { applied: true } }) })
  const { s, log } = senders()
  const sum = await runReceiptPasses(q.admin, now, s)
  assertEquals(sum.applied, 1)
  assertEquals(log.results.length, 1) // once-only transactional notice: trip quiet hours do not hold it
})

Deno.test('runner: apply answering {skipped:"not_itemised"} is quiet: counted as skipped, not applied, no error, no notice', async () => {
  const f = fakeAdmin({ rows: [row({ claim_deadline: hrs(-1) })], apply: () => ({ data: { applied: false, already_applied: false, skipped: 'not_itemised' } }) })
  const { s, log } = senders()
  const sum = await runReceiptPasses(f.admin, now, s)
  assertEquals([sum.applied, sum.apply_skipped, sum.errors, log.results], [0, 1, 0, []])
  assertEquals(f.rpcCalls, ['apply_receipt_deadline:e1']) // never p_preview
})

Deno.test('runner: not_itemised and other permanent refusals are skipped quietly, no error', async () => {
  const f = fakeAdmin({ rows: [row({ claim_deadline: hrs(-1) })], apply: () => ({ error: { code: 'P0001', hint: 'not_itemised', message: 'Not itemised' } }) })
  const sum = await runReceiptPasses(f.admin, now, senders().s)
  assertEquals(sum.errors, 0)
  assertEquals(sum.apply_skipped, 1)
  assertEquals(isPermanentApplyRefusal({ hint: 'frozen' }), true)
  assertEquals(isPermanentApplyRefusal({ message: 'This receipt is not itemised' }), true)
  assertEquals(isPermanentApplyRefusal({ message: 'boom' }), false)
})

Deno.test('result recovery helpers', () => {
  assertEquals(resultRecoveryRecipients({ claims, payerId: 'payer', alreadyNotified: new Set() }), [{ userId: 'a', amount: 4, totalAfter: 14 }])
  assertEquals(resultRecoveryRecipients({ claims, payerId: 'payer', alreadyNotified: new Set(['a']) }), [])
  assertEquals(selectRecentlyClosed([closedRow(), closedRow({ claims_closed_at: null }), closedRow({ claims_closed_at: hrs(-170) }), closedRow({ claims_closed_at: hrs(-167) })], now).length, 2)
})

Deno.test('runner: missing RPC stops the apply pass after the first; per-receipt errors are isolated', async () => {
  const rows = [row({ id: 'e1', claim_deadline: hrs(-2) }), row({ id: 'e2', claim_deadline: hrs(-3) })]
  const f = fakeAdmin({ rows })
  const { s } = senders()
  const sum = await runReceiptPasses(f.admin, now, s)
  assertEquals(f.rpcCalls.filter((c) => c.startsWith('apply')).length, 1)
  assertEquals(sum.rpc_missing, true)
  const g = fakeAdmin({ rows, apply: (id) => id === 'e1' ? { error: { code: 'XX000', message: 'boom' } } : { data: { applied: true, people: [{ user_id: 'a', amount: 1 }] } } })
  const { s: s2 } = senders()
  const sum2 = await runReceiptPasses(g.admin, now, s2)
  assertEquals(sum2.errors, 1)
  assertEquals(sum2.applied, 1)
})

Deno.test('runner: pre-migration (column missing) is a no-op; quiet hours defer nothing', async () => {
  const f = fakeAdmin({ selectError: { code: '42703', message: 'column expenses.claims_sent_at does not exist' } })
  const sum = await runReceiptPasses(f.admin, now, senders().s)
  assertEquals(sum.skipped_reason, 'migration_not_applied')
  assertEquals(sum.errors, 0)
  const q = fakeAdmin({ rows: [row({ claim_deadline: hrs(-1), trip: { chase_settings: { quiet_hours: { start: 10, end: 14 } } } })] })
  await runReceiptPasses(q.admin, now, senders().s)
  assertEquals(q.rpcCalls, ['apply_receipt_deadline:e1']) // the apply is not deferred by quiet hours (nor are the reminder and result emails)
})

Deno.test('sender adapter: no email provider -> null (so nothing is applied silently); otherwise binds sender, URL and minor units', async () => {
  const noMail = { available: false, send: () => Promise.resolve({}) } as unknown as EmailSender
  assertEquals(createReceiptSenders(noMail, 'https://x'), null)
  const calls: unknown[] = []
  const mail = { available: true, send: () => Promise.resolve({}) } as unknown as EmailSender
  const fake: SharedSenders = {
    sendReceiptReminderNotice: ((_a: unknown, _s: unknown, o: unknown) => { calls.push(['reminder', o]); return Promise.resolve({ sent: true, reason: null }) }) as SharedSenders['sendReceiptReminderNotice'],
    sendReceiptResultNotice: ((_a: unknown, _s: unknown, o: unknown) => { calls.push(['result', o]); return Promise.resolve({ sent: true, reason: null }) }) as SharedSenders['sendReceiptResultNotice'],
  }
  const s = createReceiptSenders(mail, 'https://x', fake)!
  await s.sendReceiptReminderNotice({ admin: {}, expenseId: 'e', userId: 'u', deadline: 'd' })
  await s.sendReceiptResultNotice({ admin: {}, expenseId: 'e', userId: 'u', amount: 4.5, totalAfter: 20, currency: 'GBP' })
  await s.sendReceiptResultNotice({ admin: {}, expenseId: 'e', userId: 'v', amount: 500, totalAfter: null, currency: 'JPY' })
  assertEquals(calls, [
    ['reminder', { expenseId: 'e', userId: 'u', appBaseUrl: 'https://x' }],
    ['result', { expenseId: 'e', userId: 'u', leftoverAmountMinor: 450, totalMinor: 2000, appBaseUrl: 'https://x' }],
    ['result', { expenseId: 'e', userId: 'v', leftoverAmountMinor: 500, totalMinor: 500, appBaseUrl: 'https://x' }],
  ])
})
