#!/usr/bin/env node
/**
 * Cross-copy drift check (WSH, plan §16/§18: reliability + CI gate).
 *
 * Several modules are hand-maintained as "manual mirrors" because Deno edge
 * functions (supabase/functions/**) cannot import across the boundary from
 * the Vite frontend (src/**):
 *   - src/shared/contracts/*        <-> supabase/functions/_shared/contracts/*
 *   - src/lib/money/{currencyExponent,minorUnits}.ts
 *                                   <-> supabase/functions/_shared/money/*
 *
 * The two copies of each file are expected to differ ONLY in:
 *   - the zod import specifier ('zod' vs 'npm:zod@3')
 *   - relative import extensions ('./common' vs './common.ts')
 *   - comment/doc-comment wording (each side documents itself for its own
 *     audience -- the frontend copy doesn't need to explain why it's a
 *     mirror, the edge-function copy does)
 *
 * This script normalizes both of those (imports + comments/whitespace) and
 * then requires an EXACT match on the remaining code. Any real logic drift
 * (a bug fixed on one side but not the other, a changed rate, a renamed
 * export, etc.) fails the check. Run: `node scripts/check-contract-drift.mjs`
 * (also wired into CI, see .github/workflows/ci.yml).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Mirror pairs: [frontend dir, edge-function dir, label]. */
const MIRROR_PAIRS = [
  ['src/shared/contracts', 'supabase/functions/_shared/contracts', 'contracts'],
  ['src/lib/money', 'supabase/functions/_shared/money', 'money'],
]

/**
 * Strips /* *\/ block comments and // line comments, then collapses all
 * whitespace runs to a single space and trims. Adequate for these files
 * (no string literals containing `//` or `/*`, no template-literal regex
 * edge cases) -- this is a build-time hygiene script, not a JS parser.
 */
function stripCommentsAndWhitespace(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalizes import specifiers so the two sides' *code* (not tooling
 * concerns) can be compared:
 *   - `from 'zod'`            -> `from 'npm:zod@3'`   (Deno needs the npm: specifier)
 *   - `from 'npm:zod@3'`      -> `from 'npm:zod@3'`   (already normalized, no-op)
 *   - `from './foo'`          -> `from './foo.ts'`    (Deno requires explicit extensions)
 *   - `from './foo.ts'`       -> `from './foo.ts'`    (already normalized, no-op)
 * Applied to BOTH sides so the check doesn't care which side is "missing"
 * the specifier detail -- it only cares that, once normalized, the two
 * files describe the same imports.
 */
function normalizeImports(src) {
  return src
    .replace(/from\s+'zod'/g, "from 'npm:zod@3'")
    .replace(/from\s+"zod"/g, 'from "npm:zod@3"')
    .replace(/from\s+'(\.\/[a-zA-Z0-9_-]+)'/g, "from '$1.ts'")
    .replace(/from\s+'(\.\/[a-zA-Z0-9_-]+)\.ts\.ts'/g, "from '$1.ts'") // idempotent guard
}

function normalize(src) {
  return stripCommentsAndWhitespace(normalizeImports(src))
}

function listTsFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => extname(f) === '.ts' && !f.endsWith('.test.ts'))
    .sort()
}

let failures = []
let infoOnly = []
let checkedCount = 0

for (const [frontendRel, edgeRel, label] of MIRROR_PAIRS) {
  const frontendDir = join(repoRoot, frontendRel)
  const edgeDir = join(repoRoot, edgeRel)

  const frontendFiles = new Set(listTsFiles(frontendDir))
  const edgeFiles = new Set(listTsFiles(edgeDir))

  const onlyFrontend = [...frontendFiles].filter((f) => !edgeFiles.has(f))
  const onlyEdge = [...edgeFiles].filter((f) => !frontendFiles.has(f))

  for (const f of onlyFrontend) {
    infoOnly.push(`[${label}] ${frontendRel}/${f} has no mirror in ${edgeRel}/ (not necessarily a problem -- only flag if the edge functions actually need it)`)
  }
  for (const f of onlyEdge) {
    infoOnly.push(`[${label}] ${edgeRel}/${f} has no source in ${frontendRel}/ (edge-only file, or the frontend original was removed/renamed)`)
  }

  const shared = [...frontendFiles].filter((f) => edgeFiles.has(f))
  for (const f of shared) {
    checkedCount++
    const frontendSrc = readFileSync(join(frontendDir, f), 'utf8')
    const edgeSrc = readFileSync(join(edgeDir, f), 'utf8')
    const normFrontend = normalize(frontendSrc)
    const normEdge = normalize(edgeSrc)
    if (normFrontend !== normEdge) {
      failures.push({ label, file: f, frontendPath: join(frontendRel, f), edgePath: join(edgeRel, f) })
    }
  }
}

if (infoOnly.length > 0) {
  console.log('Info (unmirrored files -- not a failure):')
  for (const line of infoOnly) console.log(`  - ${line}`)
  console.log('')
}

if (failures.length > 0) {
  console.error(`Contract/money drift detected in ${failures.length} file(s):\n`)
  for (const f of failures) {
    console.error(`  [${f.label}] ${f.frontendPath}  <->  ${f.edgePath}`)
  }
  console.error(
    '\nThese file pairs are hand-maintained mirrors (Deno edge functions cannot import\n' +
    "across the supabase/functions boundary from src/). After normalizing the zod\n" +
    "import specifier, relative-import '.ts' extensions, and stripping comments/\n" +
    'whitespace, the two sides still differ -- meaning real logic has drifted.\n' +
    'Update both copies to match, then re-run this script.\n'
  )
  process.exit(1)
}

console.log(`Contract/money drift check passed (${checkedCount} mirrored file(s) checked, ${infoOnly.length} info note(s)).`)
