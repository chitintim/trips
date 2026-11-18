# Receipt claims v2: migration rehearsal

`20261124090000_receipt_claims_rehearsal.sql` applies `supabase/migrations/20261124090000_receipt_claims_v2.sql` and exercises it on the
private test trip `be551bc4-a524-4b6a-a0c9-b74a7168ced4` ("TEST payment email - delete me"), then **ends in an error so that everything rolls
back**. Nothing is kept: no migration, no test expense, no claims. It does not send email, call `pg_net` or write to any other trip (other trips
are only read by the guard helpers).

## How to run

Paste the whole file into the Supabase dashboard SQL editor and run it **as ONE batch** (never in pieces, never with a `COMMIT` added). The
batch is `BEGIN; ...; <final DO block raising an exception>; ROLLBACK;`, so the result pane shows an error whose message is the report:

    REHEARSAL PASS (27 steps, 0 failed) [{"ok": true, "step": "...", "detail": "..."}, ...]
    REHEARSAL FAIL (27 steps, 2 failed) [{"ok": false, ...}, ...]      <- failing steps are listed first

Any other error (a syntax error, a lock timeout, a constraint failure inside the migration itself) also aborts and rolls back; its message
says where. If the pane shows no error at all, something is wrong: run `ROLLBACK;` on its own.

Run it at a quiet time. The migration takes `ACCESS EXCLUSIVE` locks on `expenses`, `expense_item_claims` and `expense_line_items` for about
1-3 seconds and `SHARE ROW EXCLUSIVE` on `users` (the new foreign keys); `lock_timeout` is 5 s and `statement_timeout` 60 s, so it fails fast
instead of queueing behind a long transaction.

## What it checks

Structure after apply (columns, the three CHECKs, the three new triggers plus the live status trigger, a single `freeze_settlements` overload
with the expected body md5, EXECUTE privileges for anon / authenticated / service_role on all 19 new or replaced functions); the freeze-guard
helpers `_trip_unclaimed_receipts` / `_trip_overclaimed_receipts` on every trip (only test trips may be flagged; counts are in the detail);
then on the test trip, impersonating the trip's creator (A, the payer) and another participant (B) through `request.jwt.claims` and
`SET LOCAL ROLE authenticated`: one itemised GBP expense (3 lines, a 3-unit line, a 0.01 line) and `set_receipt_claims` (sums, sources, status);
B toggling themself (allowed) and someone else (refused); B's direct INSERT with forged `source` / `created_by` / `leftover_*` (stored as
self / B / 0), UPDATE of their own claim, an over-claiming write (refused `overclaimed`) and a write with the wrong `expense_id` (refused
`bad_expense`); `freeze_settlements` refused with hint `unclaimed_receipts` while line 3 is open; `share_receipt_leftovers` preview (writes
nothing), `everyone` (every line and the receipt add up exactly, no duplicate keys, no zero-quantity rows) and `same` (identical rows); the
live status trigger and the final `expenses.status`; `freeze_settlements` succeeding; and, once frozen, `set_receipt_claims`,
`share_receipt_leftovers` and a direct claim INSERT all refused with hint `frozen`. Each step runs in its own sub-block and records into the
temp table `_rehearsal(step, ok, detail)`; a failed assertion is recorded, never raised.

If B happens to be able to manage the trip, "B toggling someone else" is reported as skipped (and passes). If other itemised receipts on the
test trip still have unclaimed value, the final freeze may be refused for *them*; that passes as long as the refusal does not name the
rehearsal receipt.

## The file is generated: rebuild after ANY migration edit

    node scripts/build-rehearsal.mjs

It embeds the migration verbatim into `rehearsal.template.sql` and computes the expected `freeze_settlements` body md5 from the migration
text, so the copy can never drift. Edit `rehearsal.template.sql`, never the generated `.sql`.

---

# Receipt deadline + links (phase 2): migration rehearsal

`20261126090000_receipt_deadline_rehearsal.sql` applies `supabase/migrations/20261126090000_receipt_deadline_tokens.sql` (phase 1, `20261124090000`, is
already live and is NOT embedded) and exercises it on the same private test trip, then **ends in an error so that everything rolls back**. Run it exactly like the
first one: paste the whole file into the SQL editor as ONE batch; the result pane shows `REHEARSAL PASS (65 steps, 0 failed) [...]` or `REHEARSAL FAIL ...`.
It sends no email and writes nothing outside the transaction (it also checks that `notifications` did not change).

What it checks, in order: before the migration, the live `_receipt_tagged` / `_receipt_leftover_confirmed` are exactly the phase-1 bodies (the migration replaces both) and the
phase-2 names are free; after it, the columns, the three tables with RLS (four policies on the responses, none on the token tables), the triggers, `freeze_settlements`
untouched, the EXECUTE matrix for the 16 new functions, and that `auth.uid()` / `auth.role()` follow `request.jwt.*` (what the link functions rely on). Then on the test
trip, as A (creator, payer) and B (another participant): an itemised receipt; A `send_receipt_to_table` twice (18:00 UTC default deadline, notify = [B], idempotent); B
cannot extend; B's direct UPDATE of the deadline columns is ignored; B's own answer through RLS (fresh `responded_at`), not for A, the payer cannot be "not there", B
with claims cannot be "not there", A reads B's answer; the token functions are closed to signed-in clients; as the service role: issue, peek, `toggle` off and on AS B
(rows exact, `created_by` B, settings restored), undo / done, the payer's link refuses "not there", an expired link, the rate-limit helper; the leftover rule (B confirmed,
A did not, so A takes the 6.00 dessert) through the PUBLIC preview; `extend_receipt_deadline`; `apply_receipt_deadline` as the service role (not due, then after the
deadline: applied once, receipt exact, a link refused with `deadline_passed` / `closed`, a second call a no-op); client answers refused once shared; and on a frozen trip
`send`, `apply` and a client answer are all refused with hint `frozen`. If the test trip is frozen it is unfrozen inside the transaction first.

Rebuild after ANY edit of the migration or `rehearsal_phase2.template.sql`:

    node scripts/build-rehearsal.mjs        # builds both rehearsal files

Phase 2 review additions: the rehearsal never uses `SET ROLE service_role` (only the claims-based impersonation the phase-1 rehearsal proved on live); it also
exercises a successful "I wasn't there" on a receipt with a table item (and undo), `apply_receipt_deadline` preview, a link toggle after leftovers were shared, re-itemise
with leftovers and a removed line, a plain expense with a real split row converted, and reopen + Share now. `pre.begin_live` / `pre.unfreeze_live` fail if the live bodies
of the replaced `_receipt_begin` / `unfreeze_settlements` differ from the repo text.

---

# Trip chat switches (`20261130090000_chat_settings`): migration rehearsal

`20261130090000_chat_settings_rehearsal.sql` (generated from `rehearsal_chat_settings.template.sql` + `supabase/migrations/20261130090000_chat_settings.sql` by `node scripts/build-rehearsal.mjs`)
applies ONLY that migration (the three trip-chat migrations are live), exercises the site and trip switches on the private test trip and **ends in an error so everything rolls back**. Run it
like the others: paste the whole file into the SQL editor as ONE batch; the result is `REHEARSAL PASS (31 steps, 0 failed) [...]` or `REHEARSAL FAIL ...`.
It uses the real site admin and a real organiser, plain member and outsider of the test trip (no user row is changed), impersonating them with claims + `SET LOCAL ROLE authenticated|anon`.
Checks: names free and helpers present before; RLS on, no policies, no client privilege, function privileges, seed (site `actions`/`upcoming`, test trip `actions = on`) after; member / organiser /
admin reads; anon, outsider, member-set, direct table read/write and organiser-as-admin all refused; organiser switch off / back to inherit / cannot force on / invalid value; admin force on; the
frozen test trip (frozen inside the transaction; skipped with a note if the database refuses that) still accepts the organiser; site mode `answers` and `off`; the admin list covers every trip;
the site row cannot be deleted. Pre-flight: group 26 of `supabase/PRE_APPLY_CHECKS.sql`.
