import { assertEquals } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import { BilledAiCallError } from '../_shared/anthropic.ts'
import { refundIfUnbilled, shouldRefund, type RpcClient } from './refund.ts'

function fakeClient(result: { error: { code?: string } | null } | Error = { error: null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args })
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
  }
  return { client, calls }
}
const TARGET = { feature: 'parse_receipt', capacity: 20 }
const billed = (code: 'unreadable' | 'busy' = 'unreadable') =>
  new BilledAiCallError(new AiCallError(code, 'x'), { input_tokens: 5, output_tokens: 5 }, 'm')

Deno.test('refund only when the model never ran', async () => {
  const unbilled = [
    new AiCallError('busy', 'http 529'),
    new AiCallError('rate_limited', 'http 429'),
    new AiCallError('too_large', 'file'),
    new AiCallError('unsupported_type', 'heic'),
    new AiCallError('unreadable', 'http 400 bad image'), // API rejected it: no completed call
    new Error('storage'),
  ]
  for (const e of unbilled) {
    const f = fakeClient()
    assertEquals(await refundIfUnbilled(f.client, 'u1', TARGET, e), true)
    assertEquals(f.calls, [{ fn: 'refund_rate_limit', args: { p_user_id: 'u1', p_feature: 'parse_receipt', p_capacity: 20 } }])
  }
  for (const e of [billed('unreadable'), billed('busy'), new BilledAiCallError(new AiCallError('busy', 'timeout'), { input_tokens: 0, output_tokens: 0 }, 'm', false)]) {
    const f = fakeClient()
    assertEquals(shouldRefund(e), false)
    assertEquals(await refundIfUnbilled(f.client, 'u1', TARGET, e), false)
    assertEquals(f.calls.length, 0)
  }
})

Deno.test('refund is fail-soft and logs only the code', async () => {
  const logged: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
  try {
    await refundIfUnbilled(fakeClient({ error: { code: '42883' } }).client, 'u1', TARGET, new AiCallError('busy'))
    await refundIfUnbilled(fakeClient(new Error('SECRET boom')).client, 'u1', TARGET, new AiCallError('busy'))
  } finally { console.error = orig }
  assertEquals(logged.some((l) => l.includes('42883')), true)
  assertEquals(logged.join(' ').includes('SECRET'), false)
})
