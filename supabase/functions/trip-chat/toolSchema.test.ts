// Offline guard for the one thing the mocked tests never saw: the Anthropic API validates tool schemas.
// Everything asserted here was learned from live 400s (see toolSchema.ts). No network.
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { buildToolDefs, ALL_TOOLS, LEGACY_PROPOSE_ACTIONS } from './registry.ts'
import { normalizeToolInput, toApiSchema } from './toolSchema.ts'
import { assertStored } from './tools/propose/helpers.ts'
import { makeCtx } from './tools/propose/testing.ts'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])
/** How a JS value's JSON type is named, for enum-vs-type checks. */
const typeOfValue = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)

/** Visits every schema node (properties, items, anyOf/oneOf/allOf, additionalProperties) with its path. */
function walk(node: unknown, path: string, visit: (n: Json, path: string) => void) {
  if (!isObj(node)) return
  visit(node, path)
  if (isObj(node.properties)) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`, visit)
  if (node.items) walk(node.items, `${path}[]`, visit)
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) if (Array.isArray(node[key])) (node[key] as unknown[]).forEach((n, i) => walk(n, `${path}.${key}[${i}]`, visit))
  if (isObj(node.additionalProperties)) walk(node.additionalProperties, `${path}.additionalProperties`, visit)
}

Deno.test('every declared tool schema obeys what the API enforces', () => {
  const defs = buildToolDefs()
  assert(defs.length >= 20, 'the tool list should not silently shrink')
  const names = new Set<string>()
  let unions = 0
  for (const d of defs) {
    assert(/^[a-zA-Z0-9_-]{1,64}$/.test(d.name), `bad tool name ${d.name}`)
    assert(!names.has(d.name), `duplicate tool ${d.name}`)
    names.add(d.name)
    assert(d.description.trim().length > 20, `${d.name}: needs a real description`)
    // strict mode cannot take these schemas (16 union-param limit, nullable-enum rejection); plain tools only.
    assert(!('strict' in d), `${d.name}: must not be strict`)
    const root = d.input_schema
    assertEquals(root.type, 'object', `${d.name}: root must be an object`)
    walk(root, d.name, (n, path) => {
      // No `type: [...]` arrays at all: the API rejects an enum next to one, and plain optional params need none.
      assert(!Array.isArray(n.type), `${path}: type must be a single string, got ${JSON.stringify(n.type)}`)
      if (n.type !== undefined) assert(JSON_TYPES.has(n.type as string), `${path}: unknown type ${n.type}`)
      if (Array.isArray(n.enum)) {
        assert(n.enum.length > 0, `${path}: empty enum`)
        for (const e of n.enum) {
          assert(e !== null, `${path}: null in enum`)
          const t = typeOfValue(e)
          assert(n.type === undefined || n.type === t || (n.type === 'number' && t === 'integer'), `${path}: enum value ${JSON.stringify(e)} does not match declared type ${n.type}`)
        }
      }
      if (n.type === 'object' && isObj(n.properties)) {
        const props = Object.keys(n.properties)
        const req = (n.required as string[] | undefined) ?? []
        for (const r of req) assert(props.includes(r), `${path}: required "${r}" is not a property`)
        if (d.name !== LEGACY_PROPOSE_ACTIONS) assertEquals(n.additionalProperties, false, `${path}: objects must close additionalProperties`)
      }
      if (n.type === 'array') assert(isObj(n.items), `${path}: arrays need items`)
      if (Array.isArray(n.anyOf) || Array.isArray(n.oneOf)) unions++
    })
  }
  // Even though tools are not strict, stay inside strict mode's union budget so strict can be switched back on.
  assert(unions <= 16, `${unions} union-typed nodes; strict mode allows 16`)
})

Deno.test('the legacy propose_actions tool stays a plain open schema', () => {
  const d = buildToolDefs().find((t) => t.name === LEGACY_PROPOSE_ACTIONS)!
  assertEquals(d.input_schema.required, ['actions'])
})

Deno.test('nullable parameters become optional (not in required)', () => {
  for (const t of ALL_TOOLS) {
    const original = t.inputSchema
    const api = buildToolDefs().find((d) => d.name === t.name)!.input_schema
    const props = (original.properties ?? {}) as Record<string, Json>
    const apiRequired = (api.required as string[] | undefined) ?? []
    for (const [name, p] of Object.entries(props)) {
      const nullable = Array.isArray(p.type) && p.type.includes('null')
      assertEquals(apiRequired.includes(name), !nullable, `${t.name}.${name}`)
    }
  }
})

Deno.test('toApiSchema rewrites a nullable enum into a plain enum', () => {
  const out = toApiSchema({ type: 'object', properties: { a: { type: ['string', 'null'], enum: ['x', 'y', null] }, b: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false }) as Json
  assertEquals(out.required, ['b'])
  assertEquals((out.properties as Json).a, { type: 'string', enum: ['x', 'y'] })
})

Deno.test('normalizeToolInput: omitted, null, empty and blank optional values all mean "not given" (null)', () => {
  const schema = ALL_TOOLS.find((t) => t.name === 'propose_add_todo')!.inputSchema
  for (const missing of [undefined, null, '', '  ']) {
    const raw: Json = { title: 'Book the ferry', who: 'me', due: 'none', notes: missing, person_id: missing, due_date: missing }
    if (missing === undefined) { delete raw.notes; delete raw.person_id; delete raw.due_date; delete raw.question_id }
    const out = normalizeToolInput(schema, raw) as Json
    assertEquals([out.notes, out.person_id, out.due_date, out.question_id], [null, null, null, null])
    assertEquals(out.title, 'Book the ferry')
  }
})

Deno.test('normalizeToolInput leaves required values and unknown keys for zod to judge', () => {
  const schema = ALL_TOOLS.find((t) => t.name === 'propose_add_todo')!.inputSchema
  const out = normalizeToolInput(schema, { title: '', who: 'me', due: 'none', bogus: 1 }) as Json
  assertEquals(out.title, '')
  assertEquals(out.bogus, 1)
  assertEquals(normalizeToolInput(schema, 'not an object'), 'not an object')
})

Deno.test('a call that omits every optional field still stores a proposal after normalising', async () => {
  const h = makeCtx()
  const t = ALL_TOOLS.find((x) => x.name === 'propose_add_todo')!
  const r = await t.run(normalizeToolInput(t.inputSchema, { title: 'Book the ferry', who: 'me', due: 'none' }), h.ctx)
  assertStored(r, h)
})

Deno.test('an unknown key or bad value is a plain tool error, not a throw', async () => {
  const h = makeCtx()
  const t = ALL_TOOLS.find((x) => x.name === 'propose_add_todo')!
  const r = await t.run(normalizeToolInput(t.inputSchema, { title: 'x', who: 'martian', due: 'none', bogus: 1 }), h.ctx)
  assertEquals(r.is_error, true)
})

// Card copy must never name a button label that is not on the card (tap cards say "Confirm", review cards use their own label).
import { STATIC_SYSTEM } from './prompt.ts'
Deno.test('prompt and tool text never name a card button', () => {
  assert(!/\b(tap|taps|press|click)\s+(Confirm|Suggest|Add)/i.test(STATIC_SYSTEM), 'prompt names a button')
  for (const t of ALL_TOOLS) assert(!/\b(tap|taps|press|click)\s+(Confirm|Suggest|Add)/i.test(t.description), `${t.name} names a button`)
  assert(/never say where the button is/.test(STATIC_SYSTEM))
})
