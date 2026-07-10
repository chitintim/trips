#!/usr/bin/env node
/**
 * Systemic layering (z-index) lint (UX_REDESIGN.md "Systemic layering
 * (z-index) fix — bug class, not bug", §4: "Audit: grep every `z-` usage
 * in src/, map to the token scale, fix violators... add a lint-ish check").
 *
 * The rule being enforced (see UX_REDESIGN.md for the full rationale):
 *   1. App chrome (Header, BottomNav, AppShell sidebar) sits at
 *      `z-[var(--z-sticky)]` / `z-sticky` (1100), always.
 *   2. NOTHING inside tab/feature content may exceed `z-30`. In-content
 *      sticky elements (day headers, section headers, lens switchers) use
 *      z-10..z-30 and must live inside a `position:relative` scroll
 *      container so they can't leak into the chrome's stacking context.
 *   3. Overlays (Modal/Sheet/Toast/popover) keep the token scale
 *      (1200+: z-modal/z-popover/z-tooltip/z-toast), portal-rendered to
 *      body — never nested in content.
 *
 * This script greps every `z-` Tailwind utility under src/ and fails if a
 * "high" z-index (the named chrome/overlay tokens, or any numeric/bracket
 * utility >= 40) shows up outside the small allowlist of chrome/overlay
 * components that are *supposed* to sit above the z-30 content ceiling.
 * Everything else must stay at z-0..z-30.
 *
 * Run: `node scripts/check-zindex.mjs` (also wired into CI, see
 * .github/workflows/ci.yml, as a step after lint).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(repoRoot, 'src')

// Chrome (rule 1) and overlay (rule 3) components: the ONLY places allowed
// to use the high/named z-index tokens. Paths are relative to src/ and
// matched as a prefix, so a directory allows every file beneath it.
const ALLOWLIST = [
  // App chrome — explicit z-sticky (rule 1).
  'components/layout/Header',
  'components/layout/BottomNav',
  'components/layout/AppShell',
  // Page-level chrome headers (the trip/dashboard page's own persistent
  // header, equivalent to `Header` for that page) — also z-sticky.
  'pages/TripDetail.tsx',
  'pages/Dashboard.tsx',
  // Overlays — portal-rendered, token scale (rule 3).
  // AuthCallback mounts ABOVE the Router in App.tsx (not a route), so its
  // full-page auth-processing scrim must cover route content AND chrome.
  'components/AuthCallback.tsx',
  'components/ui/Modal',
  'components/ui/Toast',
  'components/ui/SelectionAvatars',
  'features/decisions/components/MatrixView.tsx',
  'components/InstallPrompt.tsx',
  // Local absolute-positioned popovers anchored within their own
  // `position:relative` wrapper (not fixed/portal, but bounded and never
  // competing with page-scroll chrome) — dropdown-scale is appropriate.
  'features/expenses/components/AmountCurrencyInput.tsx',
  // Dev-only component gallery, not real app chrome.
  'pages/ComponentShowcase.tsx',
]

// Named token-scale utilities that are only for chrome/overlays.
const HIGH_NAMED_TOKENS = ['z-sticky', 'z-dropdown', 'z-modal', 'z-popover', 'z-tooltip', 'z-toast']

const EXTENSIONS = new Set(['.ts', '.tsx'])

/** Recursively collects every source file under `dir`. */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listFiles(full))
    } else if (EXTENSIONS.has(extname(entry))) {
      out.push(full)
    }
  }
  return out
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some((allowed) => relPath === allowed || relPath.startsWith(allowed.replace(/\.tsx?$/, '') + '/') || relPath.startsWith(allowed + '/'))
}

/**
 * Finds z-index Tailwind utilities in a line of source and returns the
 * ones that count as "high" (chrome/overlay scale), skipping z-0..z-30
 * and any bracketed arbitrary value below 40 (e.g. `z-[35]`).
 */
function findHighZUsages(line) {
  const found = []

  // Named token utilities: z-sticky, z-dropdown, z-modal, z-popover, z-tooltip, z-toast
  for (const token of HIGH_NAMED_TOKENS) {
    const re = new RegExp(`(?<![\\w-])${token}(?![\\w-])`, 'g')
    if (re.test(line)) found.push(token)
  }

  // Arbitrary bracket values: z-[40], z-[1000], z-[var(--z-dropdown)], etc.
  const bracketRe = /z-\[([^\]]+)\]/g
  let m
  while ((m = bracketRe.exec(line))) {
    const raw = m[1].trim()
    if (raw.startsWith('var(--z-')) {
      found.push(m[0])
      continue
    }
    const num = Number(raw)
    if (!Number.isNaN(num) && num >= 40) found.push(m[0])
  }

  // Plain numeric utilities >= 40: z-40, z-50, z-999...
  const numericRe = /(?<![\w-])z-(\d+)(?![\w-])/g
  while ((m = numericRe.exec(line))) {
    const num = Number(m[1])
    if (num >= 40) found.push(m[0])
  }

  return found
}

function main() {
  const files = listFiles(SRC_DIR)
  const violations = []

  for (const file of files) {
    const relPath = relative(SRC_DIR, file)
    const allowed = isAllowlisted(relPath)
    const lines = readFileSync(file, 'utf8').split('\n')

    lines.forEach((line, idx) => {
      const hits = findHighZUsages(line)
      if (hits.length === 0) return
      if (allowed) return // chrome/overlay components may use the high scale
      violations.push({ file: relPath, line: idx + 1, hits, text: line.trim() })
    })
  }

  if (violations.length > 0) {
    console.error(`z-index layering violations found in ${violations.length} location(s):\n`)
    for (const v of violations) {
      console.error(`  src/${v.file}:${v.line}  [${v.hits.join(', ')}]`)
      console.error(`    ${v.text}`)
    }
    console.error(
      '\nUX_REDESIGN.md "Systemic layering (z-index) fix": in-content elements (tab\n' +
      'panels, feature components) must stay at z-30 or below and live inside the\n' +
      "content scroll container's `position:relative` context. Only app chrome\n" +
      '(Header/BottomNav/AppShell sidebar, z-sticky) and portal-rendered overlays\n' +
      '(Modal/Toast/popovers, z-modal/z-popover/z-tooltip/z-toast) may use the high/\n' +
      'named token scale — and only from the allowlisted files in\n' +
      'scripts/check-zindex.mjs. Either cap the z-index at z-30, or — if this really\n' +
      'is new chrome/overlay code — add its path to the allowlist.\n'
    )
    process.exit(1)
  }

  console.log(`z-index layering check passed (${files.length} file(s) scanned, 0 violations).`)
}

main()
