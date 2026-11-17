// Builds supabase/rehearsal/20261124090000_receipt_claims_rehearsal.sql from the migration + supabase/rehearsal/rehearsal.template.sql.
// The migration is embedded VERBATIM and the expected freeze_settlements body md5 is computed from it, so the rehearsal can never drift.
// Re-run after ANY edit of the migration:  node scripts/build-rehearsal.mjs
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migPath = path.join(root, 'supabase/migrations/20261124090000_receipt_claims_v2.sql')
const tplPath = path.join(root, 'supabase/rehearsal/rehearsal.template.sql')
const outPath = path.join(root, 'supabase/rehearsal/20261124090000_receipt_claims_rehearsal.sql')

const mig = fs.readFileSync(migPath, 'utf8')
const tpl = fs.readFileSync(tplPath, 'utf8')

if (mig.includes('$rh$') || mig.includes('$f$')) throw new Error('the migration uses a dollar-quote tag the rehearsal needs ($rh$ / $f$)')
if (/^\s*(COMMIT|ROLLBACK|BEGIN)\b/im.test(mig.replace(/\$\$[\s\S]*?\$\$/g, ''))) throw new Error('the migration contains transaction control; the rehearsal must own the transaction')
for (const tag of ['@@MIGRATION@@', '@@FREEZE_MD5@@']) if (!tpl.includes(tag)) throw new Error('template lacks ' + tag)

// prosrc of freeze_settlements = the text between "AS $$" and the closing "$$;" of that function (stored verbatim by Postgres)
const start = mig.indexOf('CREATE OR REPLACE FUNCTION public.freeze_settlements(')
if (start < 0) throw new Error('freeze_settlements not found in the migration')
const open = mig.indexOf('AS $$', start) + 5
const close = mig.indexOf('$$;', open)
const body = mig.slice(open, close)
const md5 = crypto.createHash('md5').update(body, 'utf8').digest('hex')

const out = tpl.split('@@FREEZE_MD5@@').join(md5).replace('@@MIGRATION@@', () => mig.trimEnd())
fs.writeFileSync(outPath, out)
console.log(JSON.stringify({ out: path.relative(root, outPath), bytes: out.length, freezeMd5: md5, freezeBodyLen: body.length }))
