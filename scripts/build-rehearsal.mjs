// Builds the rollback-only rehearsal scripts in supabase/rehearsal/ from a migration + a template. The migration is embedded VERBATIM, so a rehearsal can never drift.
// Re-run after ANY edit of a migration or template:  node scripts/build-rehearsal.mjs
//   1. 20261124090000_receipt_claims_v2.sql       + rehearsal.template.sql         -> 20261124090000_receipt_claims_rehearsal.sql   (phase 1; already applied live)
//   2. 20261126090000_receipt_deadline_tokens.sql + rehearsal_phase2.template.sql  -> 20261126090000_receipt_deadline_rehearsal.sql (phase 2; applies ONLY the phase-2 file)
//   5. 20261130090000_chat_settings.sql + rehearsal_chat_settings.template.sql -> 20261130090000_chat_settings_rehearsal.sql (trip chat switches; applies ONLY that file)
//   6. 20261201090000_own_travel_and_plans.sql + rehearsal_own_travel.template.sql -> 20261201090000_own_travel_rehearsal.sql (own travel and plans RPCs; applies ONLY that file)
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

// 3. phase 4: M1 + M2 together (applied in order); the expected md5s are the shipped bodies of the two functions the earlier migrations defined and these rely on / replace
const phase2src = fs.readFileSync(rel('supabase/migrations/20261126090000_receipt_deadline_tokens.sql'), 'utf8')
{
  const m1 = fs.readFileSync(rel('supabase/migrations/20261128090000_freeze_enforcement.sql'), 'utf8')
  const m2 = fs.readFileSync(rel('supabase/migrations/20261128100000_own_claims_rpc.sql'), 'utf8')
  const all = m1 + '\n' + m2
  guardMigration(m1); guardMigration(m2)
  let tpl = fs.readFileSync(rel('supabase/rehearsal/rehearsal_phase4.template.sql'), 'utf8')
  const tags = { '@@OVERCLAIM_MD5@@': md5(body(phase1, 'guard_claim_overclaim')), '@@RESPLIT_MD5@@': md5(body(phase2src, '_receipt_resplit_table_items')) }
  for (const tag of ['@@MIGRATION1@@', '@@MIGRATION2@@', ...Object.keys(tags)]) if (!tpl.includes(tag)) throw new Error('rehearsal_phase4.template.sql lacks ' + tag)
  for (const [tag, value] of Object.entries(tags)) tpl = tpl.split(tag).join(value)
  const text = tpl.replace('@@MIGRATION1@@', () => m1.trimEnd()).replace('@@MIGRATION2@@', () => m2.trimEnd())
  fs.writeFileSync(rel('supabase/rehearsal/20261128090000_freeze_and_claims_rehearsal.sql'), text)
  console.log(JSON.stringify({ out: 'supabase/rehearsal/20261128090000_freeze_and_claims_rehearsal.sql', bytes: text.length, overclaimMd5: tags['@@OVERCLAIM_MD5@@'], resplitMd5: tags['@@RESPLIT_MD5@@'], embedded: all.length }))
}

// 4. trip chat A1: the three chat migrations applied in order
{
  const names = ['20261129090000_chat_actions.sql', '20261129100000_chat_private_threads.sql', '20261129110000_admin_ai_usage.sql']
  const ms = names.map(n => fs.readFileSync(rel('supabase/migrations/' + n), 'utf8'))
  ms.forEach(guardMigration)
  let tpl = fs.readFileSync(rel('supabase/rehearsal/rehearsal_chat.template.sql'), 'utf8')
  for (const tag of ['@@MIGRATION1@@', '@@MIGRATION2@@', '@@MIGRATION3@@']) if (!tpl.includes(tag)) throw new Error('rehearsal_chat.template.sql lacks ' + tag)
  const text = tpl.replace('@@MIGRATION1@@', () => ms[0].trimEnd()).replace('@@MIGRATION2@@', () => ms[1].trimEnd()).replace('@@MIGRATION3@@', () => ms[2].trimEnd())
  fs.writeFileSync(rel('supabase/rehearsal/20261129090000_trip_chat_rehearsal.sql'), text)
  console.log(JSON.stringify({ out: 'supabase/rehearsal/20261129090000_trip_chat_rehearsal.sql', bytes: text.length }))
}

// 5. trip chat switches (20261130090000): the three trip-chat migrations are already live, so only this migration is embedded
{
  const m = fs.readFileSync(rel('supabase/migrations/20261130090000_chat_settings.sql'), 'utf8')
  guardMigration(m)
  const tpl = fs.readFileSync(rel('supabase/rehearsal/rehearsal_chat_settings.template.sql'), 'utf8')
  if (!tpl.includes('@@MIGRATION@@')) throw new Error('rehearsal_chat_settings.template.sql lacks @@MIGRATION@@')
  const text = tpl.replace('@@MIGRATION@@', () => m.trimEnd())
  fs.writeFileSync(rel('supabase/rehearsal/20261130090000_chat_settings_rehearsal.sql'), text)
  console.log(JSON.stringify({ out: 'supabase/rehearsal/20261130090000_chat_settings_rehearsal.sql', bytes: text.length }))
}

// 6. own travel and plans (20261201090000): one new migration, embedded verbatim
{
  const m = fs.readFileSync(rel('supabase/migrations/20261201090000_own_travel_and_plans.sql'), 'utf8')
  guardMigration(m)
  const tpl = fs.readFileSync(rel('supabase/rehearsal/rehearsal_own_travel.template.sql'), 'utf8')
  if (!tpl.includes('@@MIGRATION@@')) throw new Error('rehearsal_own_travel.template.sql lacks @@MIGRATION@@')
  const text = tpl.replace('@@MIGRATION@@', () => m.trimEnd())
  fs.writeFileSync(rel('supabase/rehearsal/20261201090000_own_travel_rehearsal.sql'), text)
  console.log(JSON.stringify({ out: 'supabase/rehearsal/20261201090000_own_travel_rehearsal.sql', bytes: text.length }))
}
