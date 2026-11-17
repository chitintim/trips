import { assert, assertEquals } from 'jsr:@std/assert@1'
import type { ToolResult } from '../types.ts'
import { PROPOSE_TOOLS } from './index.ts'
import { actionRows, forbiddenWrites, type Harness } from './testing.ts'

export function tool(name: string) {
  const t = PROPOSE_TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

export function call(name: string, input: unknown, h: Harness): Promise<ToolResult> {
  return tool(name).run(input, h.ctx)
}

export function msg(r: ToolResult): string {
  const c = r.content as { error?: string; message?: string }
  return c.error ?? c.message ?? JSON.stringify(c)
}

/** The call was refused with an error and nothing was written or emitted. */
export function assertRefused(r: ToolResult, h: Harness, pattern?: RegExp) {
  assertEquals(r.is_error, true, `expected a refusal, got ${JSON.stringify(r.content)}`)
  if (pattern) assert(pattern.test(msg(r)), `message "${msg(r)}" should match ${pattern}`)
  assertEquals(actionRows(h.db).length, 0)
  assertEquals(h.emitted.length, 0)
  assertEquals(forbiddenWrites(h.db).length, 0)
}

/** Exactly one chat_actions row, emitted once, and nothing else written. */
export function assertStored(r: ToolResult, h: Harness) {
  assert(!r.is_error, `unexpected error: ${JSON.stringify(r.content)}`)
  const rows = actionRows(h.db)
  assertEquals(rows.length, 1)
  assertEquals(h.emitted.length, 1)
  assertEquals(forbiddenWrites(h.db).length, 0)
  const c = r.content as { ok: boolean; action_id: string }
  assertEquals(c.ok, true)
  assertEquals(c.action_id, rows[0].id)
  assertEquals(h.emitted[0].id, rows[0].id)
  return rows[0] as { kind: string; params: Record<string, any>; preview: Record<string, any>; basis: Record<string, any>; requires: string; status: string; trip_id: string; user_id: string; turn_id: string }
}
