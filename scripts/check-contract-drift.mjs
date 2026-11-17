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
 *   - the "Your to-dos" engine (src/lib/answers, src/lib/todos and the pure
 *     modules they import) <-> supabase/functions/_shared/{answers,todos}/*.
 *     Those files import across the src/ feature folders, so FILE_PAIRS
 *     lists, per file, which import specifiers are spelled differently on the
 *     edge side. FUNCTION_PAIRS covers a file the edge only needs a slice of.
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
  ['src/lib/actionCompletion', 'supabase/functions/_shared/actionCompletion', 'actionCompletion'],
]

/**
 * Single-file mirrors whose imports are spelled differently on the edge side
 * (the frontend file reaches into src/features/**; the edge copy lives in
 * _shared/). `rewrites` maps the FRONTEND specifier to the EDGE specifier and
 * is applied to the frontend side before comparing. Code must otherwise match.
 * [frontend file, edge file, label, rewrites]
 */
const D = 'supabase/functions/_shared/todos/deps'
const FILE_PAIRS = [
  ['src/lib/answers/answers.ts', 'supabase/functions/_shared/answers/answers.ts', 'answers', {
    '../../types/database.types': '../todos/deps/json',
    '../tripStatus': '../todos/deps/tripStatus',
    '../tripStage': '../todos/deps/tripStage',
    '../../features/decisions/lib/decisionShapes': '../todos/deps/decisionShapes',
    '../../features/people/lib/inScopePeople': '../todos/deps/inScopePeople',
  }],
  ['src/features/expenses/lib/balances.ts', 'supabase/functions/_shared/money/balances.ts', 'money-balances', {
    '../../../lib/money': './minorUnits',
    '../../../lib/queries/useExpenses': './balanceTypes',
    '../../../lib/queries/useSettlements': './balanceTypes',
  }],
  ['src/lib/ideasBucket.ts', 'supabase/functions/_shared/ideasBucket.ts', 'ideas', {}],
  ['src/lib/todos/types.ts', 'supabase/functions/_shared/todos/types.ts', 'todos', {
    '../../types/database.types': './deps/json',
    '../tripStatus': './deps/tripStatus',
  }],
  ['src/lib/todos/copy.ts', 'supabase/functions/_shared/todos/copy.ts', 'todos', {}],
  ['src/lib/todos/computeTodos.ts', 'supabase/functions/_shared/todos/computeTodos.ts', 'todos', {
    '../tripStage': './deps/tripStage',
    '../../features/people/lib/inScopePeople': './deps/inScopePeople',
    '../../features/actions/lib/actionStatus': './deps/actionStatus',
    '../../features/people/lib/travelDetails': './deps/travelDetails',
    '../../features/decisions/lib/resolveDecision': './deps/resolveDecision',
  }],
  ['src/lib/tripStage.ts', `${D}/tripStage.ts`, 'todos-deps', { '../types': './tripStatus' }],
  ['src/features/people/lib/inScopePeople.ts', `${D}/inScopePeople.ts`, 'todos-deps', {}],
  ['src/features/decisions/lib/optionMetadata.ts', `${D}/optionMetadata.ts`, 'todos-deps', { '../../../types/database.types': './json' }],
  ['src/features/decisions/lib/decisionShapes.ts', `${D}/decisionShapes.ts`, 'todos-deps', {
    '../../../lib/money': '../../money/minorUnits',
    '../../../types/database.types': './json',
  }],
  ['src/features/decisions/lib/voting.ts', `${D}/voting.ts`, 'todos-deps', { '../../../lib/queries/usePlanning': './planningTypes' }],
  ['src/features/decisions/lib/resolveDecision.ts', `${D}/resolveDecision.ts`, 'todos-deps', { '../../../types/database.types': './json' }],
  ['src/features/people/lib/travelDetails.ts', `${D}/travelDetails.ts`, 'todos-deps', {
    '../../../types': './timelineEvent',
    '../../../types/database.types': './json',
  }],
]

/**
 * Edge files that carry only some functions of a frontend file. The named
 * top-level `export function`s must match exactly (comments/whitespace aside).
 * [frontend file, edge file, label, function names]
 */
const FUNCTION_PAIRS = [
  ['src/features/actions/lib/actionStatus.ts', `${D}/actionStatus.ts`, 'todos-deps', ['withClosedSections']],
]

/** Source text of a top-level `export function name(...) {...}` (up to its closing `}` in column 0). */
function extractFunction(src, name) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`) || l.startsWith(`export function ${name}<`))
  if (start === -1) return null
  const out = []
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    if (lines[i] === '}') break
  }
  return out.join('\n')
}

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
function normalizeImports(src, rewrites = {}) {
  return src
    .replace(/from\s+'zod'/g, "from 'npm:zod@3'")
    .replace(/from\s+"zod"/g, 'from "npm:zod@3"')
    // Relative specifiers: apply the per-file rewrites, then require '.ts'.
    .replace(/from\s+'(\.{1,2}\/[^']+)'/g, (_m, spec) => {
      const mapped = rewrites[spec] ?? spec
      return `from '${mapped.endsWith('.ts') ? mapped : mapped + '.ts'}'`
    })
}

function normalize(src, rewrites = {}) {
  return stripCommentsAndWhitespace(normalizeImports(src, rewrites))
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

for (const [frontendRel, edgeRel, label, rewrites] of FILE_PAIRS) {
  checkedCount++
  const frontendPath = join(repoRoot, frontendRel)
  const edgePath = join(repoRoot, edgeRel)
  if (!existsSync(frontendPath) || !existsSync(edgePath)) {
    failures.push({ label, file: '(missing file)', frontendPath: frontendRel, edgePath: edgeRel })
    continue
  }
  const a = normalize(readFileSync(frontendPath, 'utf8'), rewrites)
  const b = normalize(readFileSync(edgePath, 'utf8'))
  if (a !== b) failures.push({ label, file: frontendRel, frontendPath: frontendRel, edgePath: edgeRel })
}

for (const [frontendRel, edgeRel, label, names] of FUNCTION_PAIRS) {
  const frontendPath = join(repoRoot, frontendRel)
  const edgePath = join(repoRoot, edgeRel)
  if (!existsSync(frontendPath) || !existsSync(edgePath)) {
    checkedCount++
    failures.push({ label, file: '(missing file)', frontendPath: frontendRel, edgePath: edgeRel })
    continue
  }
  const frontendSrc = readFileSync(frontendPath, 'utf8')
  const edgeSrc = readFileSync(edgePath, 'utf8')
  for (const name of names) {
    checkedCount++
    const a = extractFunction(frontendSrc, name)
    const b = extractFunction(edgeSrc, name)
    if (a === null || b === null || normalize(a) !== normalize(b)) {
      failures.push({ label, file: `${frontendRel}#${name}`, frontendPath: `${frontendRel}#${name}`, edgePath: `${edgeRel}#${name}` })
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
