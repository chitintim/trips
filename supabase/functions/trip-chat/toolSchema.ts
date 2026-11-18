/**
 * What goes over the wire for each tool, and how what comes back is tidied.
 *
 * Why tools are NOT `strict: true` (verified against the live API, 2026-11):
 *  - strict mode rejects `type: [t, 'null']` combined with `enum`, and allows at most 16 union-typed parameters
 *    per request ("too many parameters with union types"). This tool set needs 30 nullable parameters.
 *  - Plain, non-strict JSON Schema with truly optional parameters has no such limits.
 * Server-side validation (zod in every tool, `.strict()` objects, formats, enums) stays the authority; a bad
 * call comes back as a plain is_error result the model can correct, never a crash.
 *
 * The hand-written tool schemas keep their original shape (optional = nullable type, every key listed in
 * `required`). `toApiSchema` rewrites that into plain optional parameters for the API, and
 * `normalizeToolInput` maps what a non-strict model sends (omitted, null, "" or whitespace) to `null`, which is
 * what the zod schemas already expect for "not given".
 */

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

function isNullableType(s: Json): boolean {
  return Array.isArray(s.type) && s.type.includes('null')
}

/** Plain JSON Schema for the API: nullable -> optional (dropped from `required`), no type arrays, no null in enums. */
export function toApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toApiSchema)
  if (!isObj(schema)) return schema
  const out: Json = {}
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'properties' && isObj(v) ? mapProps(v) : toApiSchema(v)
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null')
    out.type = types.length === 1 ? types[0] : types
  }
  if (Array.isArray(out.enum)) out.enum = (out.enum as unknown[]).filter((e) => e !== null)
  if (isObj(schema.properties) && Array.isArray(schema.required)) {
    const optional = new Set(Object.entries(schema.properties).filter(([, p]) => isObj(p) && isNullableType(p)).map(([n]) => n))
    out.required = (schema.required as string[]).filter((n) => !optional.has(n))
    if ((out.required as string[]).length === 0) delete out.required
  }
  return out
}

function mapProps(props: Json): Json {
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toApiSchema(v)]))
}

/**
 * Fills the "not given" convention on a model's raw tool input, guided by the ORIGINAL (nullable-style) schema:
 * a nullable property that is missing, null, "" or whitespace-only becomes null. Nested objects/arrays are walked.
 * Required properties, unknown keys and everything else are left for zod to judge.
 */
export function normalizeToolInput(schema: unknown, input: unknown): unknown {
  if (!isObj(schema)) return input
  if (isObj(input) && isObj(schema.properties)) {
    const out: Json = { ...input }
    for (const [name, prop] of Object.entries(schema.properties)) {
      if (!isObj(prop)) continue
      const v = out[name]
      if (isNullableType(prop) && (v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))) {
        out[name] = null
        continue
      }
      if (v !== undefined) out[name] = normalizeToolInput(prop, v)
    }
    return out
  }
  if (Array.isArray(input) && isObj(schema.items)) return input.map((x) => normalizeToolInput(schema.items, x))
  return input
}
