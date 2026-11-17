// Builds the rollback-only rehearsal scripts in supabase/rehearsal/ from a migration + a template. The migration is embedded VERBATIM, so a rehearsal can never drift.
// Re-run after ANY edit of a migration or template:  node scripts/build-rehearsal.mjs
//   1. 20261124090000_receipt_claims_v2.sql       + rehearsal.template.sql         -> 20261124090000_receipt_claims_rehearsal.sql   (phase 1; already applied live)
//   2. 20261126090000_receipt_deadline_tokens.sql + rehearsal_phase2.template.sql  -> 20261126090000_receipt_deadline_rehearsal.sql (phase 2; applies ONLY the phase-2 file)
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = p => path.join(root, p)
const md5 = t => crypto.createHash('md5').update(t, 'utf8').digest('hex')

// prosrc of a function = the text between "AS $$" and the closing "$$;" of that function (stored verbatim by Postgres)
function body(mig, name) {
  const start = mig.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  if (start < 0) throw new Error(`${name} not found in the migration`)
  const open = mig.indexOf('AS $$', start) + 5
  return mig.slice(open, mig.indexOf('$$;', open))
}

function guardMigration(mig) {
  if (mig.includes('$rh$') || mig.includes('$f$')) throw new Error('the migration uses a dollar-quote tag the rehearsal needs ($rh$ / $f$)')
  if (/^\s*(COMMIT|ROLLBACK|BEGIN)\b/im.test(mig.replace(/\$\$[\s\S]*?\$\$/g, ''))) throw new Error('the migration contains transaction control; the rehearsal must own the transaction')
}

function build({ migration, template, out, tags }) {
  const mig = fs.readFileSync(rel(migration), 'utf8')
  let tpl = fs.readFileSync(rel(template), 'utf8')
  guardMigration(mig)
  for (const tag of ['@@MIGRATION@@', ...Object.keys(tags(mig))]) if (!tpl.includes(tag)) throw new Error(`${template} lacks ${tag}`)
  for (const [tag, value] of Object.entries(tags(mig))) tpl = tpl.split(tag).join(value)
  const text = tpl.replace('@@MIGRATION@@', () => mig.trimEnd())
  fs.writeFileSync(rel(out), text)
  return { out, bytes: text.length, ...Object.fromEntries(Object.entries(tags(mig))) }
}

// 1. phase 1 (unchanged behaviour)
const r1 = build({
  migration: 'supabase/migrations/20261124090000_receipt_claims_v2.sql',
  template: 'supabase/rehearsal/rehearsal.template.sql',
  out: 'supabase/rehearsal/20261124090000_receipt_claims_rehearsal.sql',
  tags: mig => ({ '@@FREEZE_MD5@@': md5(body(mig, 'freeze_settlements')) }),
})
console.log(JSON.stringify({ out: r1.out, bytes: r1.bytes, freezeMd5: r1['@@FREEZE_MD5@@'] }))

// 2. phase 2: the "live" md5s of the two functions it replaces are the phase-1 file's bodies (the rehearsal checks that live still has exactly those)
const phase1 = fs.readFileSync(rel('supabase/migrations/20261124090000_receipt_claims_v2.sql'), 'utf8')
const r2 = build({
  migration: 'supabase/migrations/20261126090000_receipt_deadline_tokens.sql',
  template: 'supabase/rehearsal/rehearsal_phase2.template.sql',
  out: 'supabase/rehearsal/20261126090000_receipt_deadline_rehearsal.sql',
  tags: () => ({
    '@@TAGGED_MD5@@': md5(body(phase1, '_receipt_tagged')), '@@CONFIRMED_MD5@@': md5(body(phase1, '_receipt_leftover_confirmed')), '@@BEGIN_MD5@@': md5(body(phase1, '_receipt_begin')),
    '@@UNFREEZE_MD5@@': md5(body(fs.readFileSync(rel('supabase/migrations/20261118100000_settlement_freeze.sql'), 'utf8'), 'unfreeze_settlements')),
  }),
})
console.log(JSON.stringify({ out: r2.out, bytes: r2.bytes, taggedMd5: r2['@@TAGGED_MD5@@'], confirmedMd5: r2['@@CONFIRMED_MD5@@'] }))
