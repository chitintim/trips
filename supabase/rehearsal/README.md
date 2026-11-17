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
