import { assert, assertEquals } from 'jsr:@std/assert@1'
import { AiCallError } from '../_shared/aiError.ts'
import { chatStreamErrorLog, chatStreamErrorPayload } from './streamError.ts'

Deno.test('chat stream error: coded generic text, never the upstream body or message', () => {
  const upstream = new Error('Claude API error (400): {"error":{"message":"SECRET prompt echo"}}')
  const p = chatStreamErrorPayload(upstream)
  assertEquals([p.type, p.code], ['error', 'unknown'])
  assert(!JSON.stringify(p).includes('SECRET'))
  assert(!chatStreamErrorLog(upstream).includes('SECRET'))

  const coded = new AiCallError('busy', 'http 529 SECRET')
  assertEquals(chatStreamErrorPayload(coded).code, 'busy')
  assert(!JSON.stringify(chatStreamErrorPayload(coded)).includes('SECRET'))
  assertEquals(chatStreamErrorLog(coded), 'busy 503')
})
