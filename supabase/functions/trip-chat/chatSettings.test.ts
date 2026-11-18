import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { decideChat, effectiveFromSettings, envActionsCeilingOff } from './chatSettings.ts'
import { actionsEnabledFor, tripIsUpcoming } from './flags.ts'

const NOW = new Date('2026-11-18T12:00:00Z')
const TRIP = 'trip-1'
const FUTURE = { start_date: '2026-12-01', end_date: '2026-12-05' }
const D30 = { start_date: '2026-09-01', end_date: '2026-10-19' } // ended 30 days ago: still upcoming
const D31 = { start_date: '2026-09-01', end_date: '2026-10-18' } // ended 31 days ago: not
const NODATES = { start_date: null, end_date: null }

Deno.test('envActionsCeilingOff: only explicit off values are a ceiling', () => {
  for (const v of ['off', 'OFF', ' off ', 'false', '0']) assert(envActionsCeilingOff(v), v)
  for (const v of [undefined, null, '', ' ', 'on', 'upcoming', 'x']) assert(!envActionsCeilingOff(v as string | undefined), String(v))
})

Deno.test('effective values: full matrix (mode x scope x trip chat x trip actions x dates) against the written rule', () => {
  let n = 0
  for (const mode of ['off', 'answers', 'actions']) for (const scope of ['upcoming', 'all']) for (const tc of ['inherit', 'off']) for (const ta of ['inherit', 'off', 'on'])
    for (const dates of [FUTURE, D30, D31, NODATES]) {
      const up = tripIsUpcoming(dates, NOW)
      const chat = mode !== 'off' && tc !== 'off'
      const actions = chat && mode === 'actions' && ta !== 'off' && (ta === 'on' || scope === 'all' || up)
      assertEquals(effectiveFromSettings({ mode, actions_scope: scope }, { chat: tc, actions: ta }, dates, undefined, NOW), { chat, actions }, JSON.stringify({ mode, scope, tc, ta, dates }))
      assertEquals(effectiveFromSettings({ mode, actions_scope: scope }, { chat: tc, actions: ta }, dates, 'off', NOW), { chat, actions: false }, 'env off ceiling')
      n++
    }
  assertEquals(n, 144)
})

Deno.test('effective values: the 30 / 31 day boundary, no trip row = inherit, dates not loaded fail closed', () => {
  const s = { mode: 'actions', actions_scope: 'upcoming' }
  assertEquals(effectiveFromSettings(s, null, D30, undefined, NOW), { chat: true, actions: true })
  assertEquals(effectiveFromSettings(s, null, D31, undefined, NOW), { chat: true, actions: false })
  assertEquals(effectiveFromSettings(s, null, NODATES, undefined, NOW), { chat: true, actions: true })
  assertEquals(effectiveFromSettings(s, null, undefined, undefined, NOW), { chat: true, actions: false })
  assertEquals(effectiveFromSettings(s, { chat: 'inherit', actions: 'on' }, undefined, undefined, NOW), { chat: true, actions: true })
})

Deno.test('effective values: an unknown value returns null (the caller falls back)', () => {
  assertEquals(effectiveFromSettings({ mode: 'loud', actions_scope: 'upcoming' }, null, FUTURE, undefined, NOW), null)
  assertEquals(effectiveFromSettings({ mode: 'actions', actions_scope: 'sometimes' }, null, FUTURE, undefined, NOW), null)
  assertEquals(effectiveFromSettings({ mode: 'actions', actions_scope: 'all' }, { chat: 'maybe', actions: 'inherit' }, FUTURE, undefined, NOW), null)
  assertEquals(effectiveFromSettings({ mode: 'actions', actions_scope: 'all' }, { chat: 'inherit', actions: 'yes' }, FUTURE, undefined, NOW), null)
})

// a minimal client: from(table).select().[limit()].[eq()].maybeSingle() resolves to results[table] (or throws)
function client(results: Record<string, { data?: unknown; error?: unknown } | 'throw'>): SupabaseClient {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      for (const m of ['select', 'limit', 'eq']) q[m] = () => q
      q.maybeSingle = () => {
        const r = results[table]
        if (r === 'throw') throw new Error('network down')
        return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null })
      }
      return q
    },
  } as unknown as SupabaseClient
}
const ok = (data: unknown) => ({ data })

Deno.test('decideChat: reads site + trip rows and decides (source db)', async () => {
  const c = client({ chat_site_settings: ok({ mode: 'actions', actions_scope: 'upcoming' }), trip_chat_settings: ok(null) })
  assertEquals(await decideChat(c, TRIP, FUTURE, undefined, NOW), { chat: true, actions: true, source: 'db' })
  assertEquals(await decideChat(c, TRIP, D31, undefined, NOW), { chat: true, actions: false, source: 'db' })
  assertEquals(await decideChat(c, TRIP, D31, 'off', NOW), { chat: true, actions: false, source: 'db' })
  const off = client({ chat_site_settings: ok({ mode: 'off', actions_scope: 'all' }), trip_chat_settings: ok({ chat: 'inherit', actions: 'on' }) })
  assertEquals(await decideChat(off, TRIP, FUTURE, 'on', NOW), { chat: false, actions: false, source: 'db' })
  const tripOff = client({ chat_site_settings: ok({ mode: 'actions', actions_scope: 'all' }), trip_chat_settings: ok({ chat: 'off', actions: 'inherit' }) })
  assertEquals((await decideChat(tripOff, TRIP, FUTURE, undefined, NOW)).chat, false)
})

Deno.test('decideChat: missing table, read error, thrown error, no row, unknown value -> the old env behaviour, never a crash', async () => {
  const missing = { error: { code: '42P01', message: 'relation does not exist' } }
  const cases: Array<[string, SupabaseClient]> = [
    ['site table missing', client({ chat_site_settings: missing, trip_chat_settings: missing })],
    ['trip table missing only', client({ chat_site_settings: ok({ mode: 'off', actions_scope: 'all' }), trip_chat_settings: missing })],
    ['read error', client({ chat_site_settings: { error: { code: '57014', message: 'timeout' } }, trip_chat_settings: ok(null) })],
    ['error without a code', client({ chat_site_settings: { error: { message: 'boom' } }, trip_chat_settings: ok(null) })],
    ['thrown', client({ chat_site_settings: 'throw', trip_chat_settings: 'throw' })],
    ['no site row', client({ chat_site_settings: ok(null), trip_chat_settings: ok({ chat: 'off', actions: 'off' }) })],
    ['unknown value', client({ chat_site_settings: ok({ mode: 'loud', actions_scope: 'all' }), trip_chat_settings: ok(null) })],
  ]
  for (const [name, c] of cases) {
    for (const flag of [undefined, '', 'off', 'on', 'upcoming', TRIP]) for (const dates of [FUTURE, D31, NODATES]) {
      const d = await decideChat(c, TRIP, dates, flag, NOW)
      assertEquals([d.chat, d.actions, d.source], [true, actionsEnabledFor(flag, TRIP, dates, NOW), 'env'], `${name} flag=${flag}`)
      assert(typeof d.fallback === 'string' && d.fallback.length > 0, name)
    }
  }
})
