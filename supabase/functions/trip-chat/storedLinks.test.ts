import { assertEquals } from 'jsr:@std/assert@1'
import { storedLinkOf } from './storedLinks.ts'
import type { ChatActionEnvelope } from './tools/types.ts'

const env = (over: Partial<ChatActionEnvelope>): ChatActionEnvelope => ({ id: 'link-t-1', kind: 'open_screen', params: {}, preview: {}, basis: {}, requires: 'link', status: 'proposed', expires_at: null, turn_id: 't', ...over }) as ChatActionEnvelope

Deno.test('storedLinkOf keeps only target, id and subject', () => {
  const id = '22222222-2222-4222-8222-222222222222'
  assertEquals(storedLinkOf(env({ params: { target: 'claim', id, open_param: `claim:${id}` }, preview: { label: 'Open', subject: '  Test dinner ' } })), { target: 'claim', id, subject: 'Test dinner' })
  assertEquals(storedLinkOf(env({ params: { target: 'settle', id: null, open_param: 'settle' } })), { target: 'settle', id: null, subject: null })
})

Deno.test('storedLinkOf drops other kinds and malformed targets', () => {
  assertEquals(storedLinkOf(env({ kind: 'add_todo' })), null)
  assertEquals(storedLinkOf(env({ params: { target: 'nope', id: null } })), null)
  assertEquals(storedLinkOf(env({ params: { target: 'claim', id: null } })), null)
  assertEquals(storedLinkOf(env({ params: { target: 'settle', id: 'x' } })), null)
})
