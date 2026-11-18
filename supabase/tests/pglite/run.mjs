// Runs a pglite suite: node supabase/tests/pglite/run.mjs <suite|all>
//   phase2   : parts/*.mjs concatenated into ONE module (the checks share variables), executed in a child node process (so a crash in one suite is reported, not hidden)
//   phase1   : phase1.mjs (receipts v2, the migration 20261124090000)
//   rehearsal / rehearsal4: rehearsal_dry.mjs (dry-runs the generated phase-2 / phase-4 rehearsal files; REH_FILE=<name> picks one)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const gen = path.join(here, '.generated')
fs.mkdirSync(gen, { recursive: true })

function buildPhase2() {
  const parts = fs.readdirSync(path.join(here, 'parts')).filter(f => f.endsWith('.mjs')).sort()
  const text = parts.map(f => `// ===== parts/${f} =====\n` + fs.readFileSync(path.join(here, 'parts', f), 'utf8')).join('\n')
  const out = path.join(gen, 'phase2.mjs')
  fs.writeFileSync(out, text)
  return out
}

const suites = {
  phase2: () => buildPhase2(),
  phase1: () => path.join(here, 'phase1.mjs'),
  rehearsal: () => path.join(here, 'rehearsal_dry.mjs'),
  rehearsalchat: () => { process.env.REH_FILE = '20261129090000_trip_chat_rehearsal.sql'; return path.join(here, 'rehearsal_dry.mjs') },
  rehearsalsettings: () => { process.env.REH_FILE = '20261130090000_chat_settings_rehearsal.sql'; return path.join(here, 'rehearsal_dry.mjs') },
  rehearsal4: () => { process.env.REH_FILE = '20261128090000_freeze_and_claims_rehearsal.sql'; return path.join(here, 'rehearsal_dry.mjs') },
}
const want = process.argv[2] ?? 'all'
const names = want === 'all' ? Object.keys(suites) : [want]
let bad = 0
for (const n of names) {
  if (!suites[n]) { console.error('unknown suite', n); process.exit(2) }
  console.log(`\n=== ${n} ===`)
  const r = spawnSync(process.execPath, [suites[n]()], { stdio: 'inherit', env: process.env })
  if (r.status !== 0) { bad++; console.log(`=== ${n}: FAILED (exit ${r.status}) ===`) }
}
process.exit(bad ? 1 : 0)
