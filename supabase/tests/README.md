# Database tests

`npm run test:db` runs three suites on an in-memory Postgres (PGlite): `phase1` (receipt claims, 20261124090000), `phase2` (everything after: deadline / links /
re-itemise / freeze enforcement / own claims; `pglite/parts/*.mjs` are concatenated into ONE module by `pglite/run.mjs` because the checks share variables) and
`rehearsal` / `rehearsal4` / `rehearsalchat` / `rehearsalsettings` (dry runs of the generated rollback-only rehearsal files in `supabase/rehearsal/`).
`node supabase/tests/pglite/run.mjs phase2` runs one suite. Rebuild the rehearsals first after editing a migration: `node scripts/build-rehearsal.mjs`.

`concurrency/locks.mjs` races real transactions on separate connections (lock-order, deadlocks, final money). It needs `TEST_PG_URL` (a Postgres 17); without it
it runs the same scenarios sequentially as a smoke test. CI: `.github/workflows/db.yml` (pglite job + a `postgres:17` service container job).

## What is stubbed (honestly)
`lib/base.mjs` documents it at the top. In short: the Supabase roles, `auth.uid()/role()` over `request.jwt.claims`, the base tables with the LIVE constraints recorded in
`scratchpad/live-checks-*.md` (amount > 0, char-length limits, the real `expense_category` labels, NOT NULL columns of `expense_allocation_links`, UNIQUE / CHECKs on claims and
line items, the settlement triggers via the repo's own migrations), RLS with the policies recorded in the live checks, and re-implementations of `guard_immutable_keys`,
`handle_updated_at` and the live status trigger (their live bodies are unknown; only md5 and behaviour are recorded). NOT modelled: policies on trips / trip_participants /
users, the other triggers on trips and trip_participants, realtime, PostgREST (request headers are set with `set_config('request.headers', ...)`), and anything that
needs real wall-clock time (deadlines are moved with UPDATEs).
