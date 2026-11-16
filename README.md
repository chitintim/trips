# Trips

A private, invitation-only group trip planner (served at https://trips.fontem.ai). A trip organiser puts questions to the group ("Which chalet?"), people answer them, the group decides, someone books, and the app keeps a single list of what each person still owes the trip (answers, RSVPs, to-dos, payments). It also tracks shared expenses in several currencies and settles up at the end.

The product model (what the words mean and how things move) is in [docs/PRODUCT_MODEL.md](docs/PRODUCT_MODEL.md). Read that first if you are changing behaviour. `UX_REDESIGN.md`, `UPGRADE_MASTER_PLAN.md` and `CONFIRMATION_SYSTEM_PLAN.md` are historical.

## Vocabulary

Eight nouns, six statuses, three RSVP words. Everything in the UI uses these and nothing else.

| Noun | Meaning |
|---|---|
| Trip | The whole thing. |
| Plan | What is happening, day by day. An entry on it is just its title. |
| Question | Something the group needs to settle. A Group choice has one answer for everyone; an Own choice is something each person picks for themselves. |
| Option | One possible answer to a question. |
| Answer | Your response to a question: your vote(s), your picks, or "No preference" / "None for me". |
| To-do | Something one specific person has to do (answer, RSVP, task, bring item, pay, confirm a payment). |
| Expense | Money someone actually paid for the group. |
| Payment | Money moving between people to settle up. |

| Status | Applies to |
|---|---|
| Open | A question that is taking answers. |
| Decided | A question (and its winning option) that has an answer. |
| Booked | A decided option with a live booking. |
| Done | A to-do that is finished. |
| Needs your answer | A question you have not answered yet (your side). |
| Answered ✓ | A question you have answered (your side). |

RSVP: the prompt is "Are you coming?" with three buttons, **I'm in**, **Not sure yet**, **Can't make it**. The chips are Going, Not sure, Not going, No reply yet and Waitlist (seven stored `confirmation_status` values map onto these five chips).

Trip stages shown to people: Who's coming, Planning, Ready to go, On the trip, Finished. The Who's coming heading reads "Who's coming · N going · M invited", and with a capacity limit the capacity card reads "N of CAP places taken · X left".

## Architecture in brief

- **Frontend:** React 18 + TypeScript + Vite, Tailwind, TanStack Query for all server state, React Router. Four spaces per trip: Today, Plan, Money, People. Deep links use `/{tripId}?open=<target>` (see `src/pages/tripDeepLinks.ts` and section 7 of the product model). Today's personal list is "Your to-dos"; the "Shared to-dos" sheet lists only the shared task-type to-dos.
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime, Edge Functions). Row-level security protects every table. Writes that must be atomic or privileged go through `SECURITY DEFINER` RPCs with a pinned `search_path` (for example `decide_question`, `mark_booked`, `freeze_settlements`, `reset_trip_confirmations`). The migrations are in `supabase/migrations/`.
- **One to-dos engine.** `src/lib/todos/computeTodos.ts` is the only place that decides what a person owes on a trip. The header count, Today's "Your to-dos", the dashboard badge, the organiser's "Waiting on" board and the reminder emails all read it, so they cannot disagree. Every string and deep link it produces lives in `src/lib/todos/copy.ts`. Whether someone has answered a question is decided in one place too, `src/lib/answers/answers.ts`.
- **Suggest an option.** People who are coming (but do not run the trip) can add an option to an open Group-choice question, or an idea to the Ideas list, through the `suggest_option` and `withdraw_suggestion` RPCs (`supabase/migrations/20261119090000_suggest_option.sql`, rules in `src/features/decisions/lib/suggestOption.ts`). The rules are in the product model, section 3.
- **Mirror in the edge function.** Deno edge functions cannot import from `src/`, so the engine (`src/lib/todos`, `src/lib/answers`, the pure modules they import), `src/lib/money` and the shared contracts are hand-copied into `supabase/functions/_shared/`. `node scripts/check-contract-drift.mjs` fails CI if the copies differ in anything but import specifiers and comments. Change both sides together.
- **The "one truth" invariant** is pinned by the unit test `src/lib/queries/todoSurfaces.test.ts`: for any trip and person, the header pill, Today's list, the dashboard badge and that person's row in "Waiting on" are the same number.
- **One answer control.** Every question is answered through the same control (`src/features/decisions/components/AnswerControl.tsx`), either on the question card or in the answer-all flow (`src/features/plan/components/AnswerFlow.tsx`). Voting, picking and passing all write through it.
- **One money formatter and one price model.** `formatMoney` in `src/lib/money/format.ts` prints every amount. `computeOptionPrice` (`src/lib/cost/optionPrice.ts`) prices an option (per person, total, certainty). `src/lib/cost/yourCost.ts` builds "Your cost", the per-person running figure on Today. All arithmetic is in integer minor units (`src/lib/money/minorUnits.ts`).
- **The daily auto-chase job** (`supabase/functions/auto-chase`, cron at 09:00 UTC) runs with the service role and does five things: sends reminders (one digest email per person per day, deep-linked to the exact thing); auto-decides Group-choice questions whose deadline just passed when there is a clear leader (never a tie). It runs only on trips whose reminder emails are on (`chase_settings.enabled`, off by default for every trip) and only while `chase_settings.auto_decide` is not false; announces decisions with the "We have an answer" email; syncs the stored trip stage forward when the dates say the trip has started or ended (a status someone changed by hand after that date boundary is left alone, and Finished waits until the day after `end_date`, UTC); and escalates items that hit the reminder cap. The engine acts as a filter on reminders: it can remove a recipient, never add one.

## Run and test

Prerequisites: Node 20 (CI uses 20) and a Supabase project (or the shared one).

```bash
npm install
cp .env.example .env     # then fill in the two VITE_ variables below
npm run dev              # http://localhost:5173/trips/  (base path is /trips/ by default)
npm run build            # tsc -b && vite build
npm run lint             # eslint . (everything)
npm run lint:ci          # eslint src --max-warnings 60 (the gate CI uses)
npm test                 # vitest run (unit tests)
npx playwright test      # unauthenticated smoke tests in e2e/ (starts the dev server itself)
node scripts/check-contract-drift.mjs   # mirror drift check
node scripts/check-zindex.mjs           # z-index layering check
```

Edge function tests (Deno, no install needed):

```bash
npx -y deno test supabase/functions/payment-notice/ supabase/functions/payment-confirm/ supabase/functions/auto-chase/ supabase/functions/_shared/payment*.test.ts
```

`deno test` leaves nothing behind except possibly a root `deno.lock`; delete it afterwards.

Warning: do not run `deno check --node-modules-dir=auto` inside this repo. It overwrites `node_modules` (found the hard way), and the fix is `rm -rf node_modules && npm ci`.

Environment variable names (values are never committed):

| Where | Names |
|---|---|
| Frontend (`.env`, GitHub secrets) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; optional `VITE_BASE` (build base path, default `/trips/`) |
| Edge functions (Supabase secrets) | `ANTHROPIC_API_KEY`, `APP_BASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`; optional `PAYMENT_CONFIRM_ALLOWED_ORIGINS` (comma-separated extra origins `payment-confirm` accepts besides `APP_BASE_URL`); `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase |

CI (`.github/workflows/ci.yml`, on pull requests and non-master pushes) runs typecheck, `npm run lint:ci`, z-index check, unit tests, drift check, build and the Playwright smoke suite.

## Deployment

- **Frontend:** push to `master`. `.github/workflows/deploy.yml` runs the same gates as CI (except Playwright), builds with the production secrets, and publishes `dist/` to GitHub Pages. The site is served at https://trips.fontem.ai: the custom domain is set in the repository's Pages settings, and the repository variable `VITE_BASE` is `/`, which `deploy.yml` passes to the build (`vars.VITE_BASE || '/trips/'`; without the variable the base is `/trips/`, the default github.io project path).
- **Database migrations are applied by hand.** Nothing applies `supabase/migrations/*.sql` automatically. Paste each new file into the Supabase SQL editor, then record it in `supabase_migrations.schema_migrations` so the history stays accurate. Before applying a risky batch, run the read-only checks in `supabase/PRE_APPLY_CHECKS.sql` against the live database and read each result against its "safe result" comment. Each new migration states in its header whether it is additive and re-runnable (most recent ones are: `CREATE OR REPLACE`, `IF NOT EXISTS`); not every historical file is, so read the header before running a file twice.
- **Edge functions** are deployed one at a time:
  ```bash
  npx -y supabase@latest functions deploy <name> --remote=vrmhwfrpdaiovulornli --use-api
  ```
  (`--remote` is the flag the current CLI accepts here; add `--yes` in a non-interactive shell.) Deploy reads the `[functions.*]` blocks (`verify_jwt`, `import_map`) in `supabase/config.toml`.
  The "X paid you" email touches two new functions and one changed one. Migrations first (apply by hand, in this order, after running the PRE_APPLY_CHECKS groups 18 and 19): `20261120090000_payment_confirm_tokens.sql`, then `20261120100000_settlement_insert_guard.sql` (closes the settlements INSERT hole; apply only if check 19a/19b shows it). Then the functions:
  ```bash
  npx -y supabase@latest functions deploy payment-notice  --remote=vrmhwfrpdaiovulornli --use-api   # verify_jwt = true (signed-in callers only)
  npx -y supabase@latest functions deploy payment-confirm --remote=vrmhwfrpdaiovulornli --use-api --no-verify-jwt   # verify_jwt = false: public, the emailed token is the credential; POST only
  npx -y supabase@latest functions deploy auto-chase      --remote=vrmhwfrpdaiovulornli --use-api   # changed: skips the daily reminder for a payment whose paid notice went out today
  ```
  `config.toml` carries the settings (`payment-notice` verify_jwt true, `payment-confirm` false). They need the same secrets as `auto-chase` (`RESEND_API_KEY` or `BREVO_API_KEY` with their sender settings, and `APP_BASE_URL`); `SUPABASE_*` are provided. **Order:** migrations, then `payment-notice`, `payment-confirm` and `auto-chase`, then the front end (a front end that calls `payment-notice` before it exists just logs a warning; it never blocks marking a payment paid; the page for the button is the public route `/confirm-payment`, which needs `payment-confirm` deployed first).
  **Email provider setting:** keep click tracking OFF for these emails (Resend: Domains, your sending domain, Click tracking; Brevo: transactional tracking). The confirm link contains a secret token; a tracked link would route it through the provider and store it in their logs.
  **Not-received flow (second step, additive; DEPLOY ORDER: migration, then functions, then front end):** (1) run PRE_APPLY_CHECKS group 20 (pre-apply part), (2) apply `20261121090000_payment_receipt_dispute.sql` (starts with `SET LOCAL lock_timeout = '5s'`, adds `settlements.receipt_disputed_at` and `settlements.last_retracted_at`, a CHECK, extends the update guard, replaces `dispute_payment_by_token`, adds `clear_receipt_dispute(uuid, text)` and `restore_receipt_dispute(uuid)`, ends with `NOTIFY pgrst, 'reload schema'`; then run the group 20 POST-APPLY checks 20p-20u and record the new guard md5), (3) deploy `payment-notice`, `payment-confirm` and `auto-chase` again, (4) then the front end. Any order is safe: the front end hides the new actions until the column exists, and the functions treat a missing column as "nothing disputed" (a transient database error is a 502, never mistaken for "missing"). The email carries two buttons (`/confirm-payment?t=<token>&a=yes|no`); `a` is only a UI hint. Who may do what to a payment, the notices with their caps and the `payment-notice` status codes (200 / 403 / 409 reasons / 429 / 502) are in docs/PRODUCT_MODEL.md section 5 and 8.
  `auto-chase` is invoked by a pg_cron job (`auto-chase-daily`) that authenticates with an `x-cron-secret` header read from the service-role-only `app_secrets` table.
- **Auth email templates** (login code and sign-up verification) live in the Supabase dashboard. `supabase/templates/` mirrors them; `supabase/config.toml` configures local development (`supabase start`) and does not change the hosted auth settings or emails, except that its `[functions.*]` blocks are read by `supabase functions deploy`. Editing the template files does not change the hosted emails.

## Layout

```
src/
  lib/todos/      the to-dos engine (+ copy.ts: all strings and deep links)
  lib/answers/    "has this person answered?"
  lib/cost/       option price, Your cost, money position
  lib/money/      the one formatter, minor units, distribution
  lib/queries/    TanStack Query hooks (todoSurfaces.ts feeds every count)
  features/       today, plan, decisions, expenses, people, organizer, ...
  pages/          TripDetail (spaces, deep links), Dashboard
  shared/contracts/  zod contracts mirrored to the edge functions
supabase/
  migrations/     SQL, applied manually
  functions/      auto-chase, payment-notice, payment-confirm, ingest, trip-chat, parse-receipt, nudge-draft,
                  reorganize-plan, refresh-fx-rates, admin-invitation-account, _shared
  templates/      mirror of the dashboard auth email templates
e2e/              Playwright smoke tests (no sign-in, no live writes)
scripts/          drift and z-index checks
```
