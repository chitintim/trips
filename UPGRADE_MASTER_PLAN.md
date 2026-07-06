# Trips v2 — Upgrade Master Plan

**Status:** Planning complete, ready for orchestrated implementation.
**Date:** 2026-07-06
**Hard constraints:** Same Supabase project. All auth users, logins, and existing data retained. Schema changes are **additive only**. Fresh frontend rebuild (new design, mobile-first, professional, destination-neutral). Edge functions rewritten in place.

---

## 1. Vision

An end-to-end group trip platform that solves the **organizer's burden**: getting people to commit, decide, pay, claim, and settle — without the organizer chasing everyone manually. The app already has unusually good bones (7-status confirmations with conditional dependencies, AI receipt itemization with claim links, multi-currency with historical FX). v2 keeps every backend concept, rebuilds the interface, upgrades the AI, adds a places/maps layer, and turns the app from a passive tracker into an **active co-organizer**.

Product principles:
1. **The organizer never chases manually.** The app knows every blocker (pending RSVP, unvoted poll, unclaimed receipt items, unpaid settlement) and generates the nudge.
2. **Paste/snap anything.** Receipts, booking confirmations, Airbnb links, Google Maps links — AI converts messy real-world input into structured trip data.
3. **Cost transparency at every stage.** From "~£730/person if you join" at the brief stage, to live estimate-vs-actual during the trip, to one optimized settlement at the end.
4. **Mobile-first, 10-second interactions.** Snap a receipt at the table and be done; claim your items in two taps from a WhatsApp link.
5. **Every place is a place.** Options, events, vendors, expenses carry locations; the trip is visible on a map.

---

## 2. What exists today (inventory of what we keep)

- **Database (17 tables, keep all):** users, trips, trip_participants, invitations, invitation_attempts, planning_sections, options, selections, comments, expenses, expense_line_items, expense_item_claims, expense_allocation_links, expense_splits, settlements, fx_rates, trip_timeline_events, trip_notes, trip_chat_messages. Plus ~13 RLS helper functions and the private `receipts` storage bucket (3MB cap, signed URLs).
- **Trip lifecycle enum:** gathering_interest → confirming_participants → booking_details → booked_awaiting_departure → trip_ongoing → trip_completed. Keep.
- **Confirmation system:** 7 statuses incl. `conditional` (date/user/both dependencies), capacity + waitlist, deadline, markdown cost brief. Keep the model; rebuild the UX (see §6).
- **Expense engine:** multi-currency, 3-tier FX cache (memory → fx_rates → frankfurter), itemized receipts with claim codes, debt minimization util. Keep concepts; harden and extend (§10–12).
- **Edge functions:** parse-receipt (Claude Sonnet 4.6 + GPT-4o-mini fallback), trip-chat (context-stuffed, msg/day caps), refresh-fx-rates (daily 16:30 UTC). All three rewritten (§13).
- **Deployment:** GitHub Pages at chitintim.github.io/trips via Actions on master push. Keep (free, working, URL preserved).
- **Stack:** React 18, React Router 7, Vite 6, Tailwind **v4 (already!)**, TypeScript strict, supabase-js 2.x. Keep the stack; add TanStack Query v5 + Supabase Realtime.

Known pain to fix: 1,600-line components (ExpensesTab, AddExpenseModal), no query cache/realtime (imperative fetches everywhere), settlement recording half-built, FX weekend/provisional-rate fragility (long trail of fix commits), receipt quantity/tax ambiguity handled by a brittle 200-line prompt, no error boundaries, no tests around money math beyond utilities, no migration files in repo (schema lives only in the live DB).

---

## 3. Data retention & migration policy

1. **Before any DDL:** take a full backup (`supabase db dump` with the project linked, or dashboard backup). Store locally, dated.
2. **Additive-only rule:** new tables, new nullable columns, new enum values (`ALTER TYPE … ADD VALUE`), new indexes. Never drop/rename/retype existing columns. Anything "replaced" is deprecated in code, not in schema.
3. **Bring schema under version control:** introduce `supabase/migrations/` from now on; first migration is a baseline dump of current schema, then one migration per change. Regenerate `database.types.ts` after each.
4. **Auth untouched.** No changes to auth schema or user rows; profile extensions go on `public.users`.
5. **RLS verification step:** after each migration batch, run an RLS smoke script (per-role queries) before deploy.

---

## 4. Architecture & stack decisions

| Area | Decision |
|---|---|
| Framework | Keep React 18 + Vite 6 + React Router 7 (CSR, basename `/trips/`). No framework churn — the win is structure, not framework. |
| Server state | **TanStack Query v5** as the single client cache over supabase-js. Supabase Realtime (`postgres_changes` per trip) triggers `invalidateQueries` — never hand-patch cache from payloads. Optimistic mutations for high-success actions (vote, RSVP, add expense); pending-state for destructive ones. |
| Client state | Local `useState`/context only. No Redux/Zustand. |
| Validation | **Zod schemas shared between frontend and edge functions** (single `src/shared/contracts/` imported by both) for every edge-function request/response and AI structured output. |
| Money | All money math in one audited module (`src/lib/money/`): integer minor-units arithmetic, largest-remainder rounding distribution, currency formatting. **No floating-point splits anywhere else.** |
| Structure | Feature folders (`src/features/expenses/`, `.../decisions/`, `.../itinerary/`…), components ≤300 lines, wizards decomposed per step. |
| PWA | Vite PWA plugin: manifest, icons, install instructions sheet (iOS), `beforeinstallprompt` button (Android), offline app shell + offline expense-capture queue (IndexedDB, syncs on reconnect). |
| Maps | **Leaflet + OpenStreetMap tiles (free, no API key)** for in-app maps; **Google Maps deep links** for navigation/directions/place pages. No Google Maps JS API (cost, key management). |
| Errors | Error boundaries per tab; Sentry (free tier) for frontend + edge functions; toast system for user-facing failures. |
| Tests | Vitest for money/FX/settlement/reconciliation logic (the bug-history areas); Playwright smoke for the 5 critical flows (login → view trip; add expense; claim items; vote; record settlement). CI runs both. |

---

## 5. Design system & UX overhaul

**Aesthetic:** professional, destination-neutral travel product. Clean neutral base (warm grays/white, dark mode support), one accent color, generous whitespace, modern grotesque type (Inter/Geist via self-hosted files), soft cards, subtle motion. **Per-trip personality instead of a global snow theme:** each trip gets an accent hue + optional cover image, so a ski trip and a Tokyo trip feel different without theming the whole app.

**Navigation model:**
- Mobile: fixed bottom tab bar (safe-area padded), 4 tabs + center floating **"+" quick-capture** button (scan receipt / add expense / paste link / add event).
- Desktop (`md:`): left sidebar, same information architecture.
- Tabs are **stage-aware**: the trip home tab is a "**Today**" screen during `trip_ongoing` (next event with map link, running spend, outstanding actions), a "**Decisions**" digest during planning, a "**Settle up**" summary after completion.
- A persistent "**Needs your attention**" strip on the dashboard and trip home: your unvoted polls, unclaimed items, unpaid settlements, pending RSVP — one tap each. This is the single most important UX element in v2.

**Modernized primitives:** rebuild `ui/` kit on Tailwind v4 tokens (`@theme` CSS variables), full-screen sheet modals on mobile, skeleton loaders (no spinner walls), empty states with a next action, pull-to-refresh on lists.

**Auth UX:** rebuilt login with two tabs — password, and **"email me a code"** (Supabase `signInWithOtp` with a 6-digit email OTP; no new infrastructure, works for every existing account, solves forgotten passwords). Invitation signup keeps codes but offers OTP-first account creation (password optional, settable later in profile). Sessions stay long-lived on trusted devices.

---

## 6. Trip lifecycle (stage-driven UX)

The six statuses stay, presented as a visible progress rail on the trip header. Each stage foregrounds different tools:

1. **Gather interest** — Trip brief page (rebuilt): cover, dates, vibe, **AI-drafted brief from organizer bullet points**, estimated per-person cost band (auto-composed: accommodation estimate + flight guess + shared costs), open questions poll ("which week works?"). One-tap "I'm interested".
2. **Confirm participants** — the existing 7-status system with a cleaner 2-step modal (status → optional condition/note). **New: dependency graph visualization** — a small directed graph of "who's waiting on whom", highlighting the keystone person ("if Sarah confirms, 3 conditionals auto-resolve — nudge Sarah"). Capacity bar, deadline countdown, waitlist auto-promotion.
3. **Decide & book** — polls/voting (§7), options with cost impact, booking tracker (§9). Booked items auto-create timeline events and can auto-create the corresponding expense.
4. **Awaiting departure** — itinerary building, map view, countdown, packing/shared checklist (lightweight `trip_checklists` — "who's bringing the speaker"), document vault (tickets/passes in the receipts bucket pattern).
5. **Trip ongoing** — Today screen, 10-second receipt capture, live balances.
6. **Completed** — settlement flow (§12), then the **trip retrospective** (§15).

---

## 7. Decision engine (polls & voting upgrade)

Today's sections/options/selections stay as the substrate. Additions (all additive schema):

- **Poll mechanics on planning_sections:** `vote_deadline`, `quorum`, `voting_method` ('single' | 'approval' | 'ranked'), `hide_votes_until_close` (default true — research: anonymity during voting improves honesty; full transparency after close builds trust), `auto_close` behavior.
- New **`option_votes`** table (option_id, user_id, rank, created_at) separate from `selections` — votes are the decision phase; `selections` remain the committed choice (e.g., which ski package *you* take).
- **Every option shows per-person cost impact** ("choosing this adds ~£54/person"), computed from price_type + current confirmed count. The section header shows the running per-person total of leading options — the "cost brief" is live, not a static message.
- Deadline + quorum → **auto-close and announce the winner** (activity feed + nudge); organizer can override.
- **Paste-a-link to create an option:** paste an Airbnb/Booking/restaurant/Google Maps URL → AI extracts title, price, location, image (§9). Kills the tedium of hand-entering options.
- Matrix/grid view for tiered options (the ski-rental matrix from PLANNING_IMPROVEMENTS.md) using existing `metadata` grid fields.
- Comments stay attached to options; add emoji quick-reactions (new `reactions` table) — half of group deliberation is just "🙌 / 😬 / 💸".

---

## 8. Places, maps & visualization layer (new)

A single **`places`** table (id, trip_id, name, lat, lng, google_place_url, google_maps_link, address, source 'manual'|'link_parse'|'receipt'|'ai', created_at) referenced by nullable `place_id` columns added to `options`, `trip_timeline_events`, and `expenses`.

- **Google Maps link parsing:** paste any Google Maps share link → extract name + coordinates (share-link resolution in an edge function to avoid CORS); store both our coords and the original link.
- **Trip map view** (Leaflet/OSM, a new top-level view per trip): itinerary events pinned and color-coded by day, connected in sequence; accommodation options plotted together to compare neighborhoods; restaurant/activity proposals shown with straight-line distance from the (selected) accommodation; toggle layer showing where money was spent (expense pins from receipt vendors).
- **Deep links out, everywhere:** every place chip has "Open in Google Maps" (place page) and "Directions" (from current location). On the Today screen, the next event's directions link is one tap.
- **Receipt → place:** parse-receipt v2 returns vendor name + any printed address; a geocode step (Nominatim, free, cached in `places`) attaches the expense to a place automatically.
- **Charts (no heavy chart lib — small Recharts or hand-rolled SVG):** spend by category donut, spend per day bars (trip timeline of burn), per-person paid-vs-owed, estimate-vs-actual gauge per category. Lives in My Spending (personal) and a new Trip Stats panel (group).

---

## 9. Bookings & paste-anything ingestion (new)

New **`bookings`** table: id, trip_id, option_id (nullable), title, vendor, confirmation_ref, booked_by, amount, currency, booking_date, **cancellation_deadline**, refundable, status ('reserved'|'paid'|'cancelled'), document_url, expense_id (nullable), timeline_event_id (nullable), place_id (nullable), notes.

- Booking an option (status → booked) prompts a 20-second flow: confirmation ref, amount paid, who paid → **auto-creates the linked expense and timeline event(s)**. This is the "clever linking" — one action populates three systems consistently.
- **Cancellation-deadline radar:** upcoming refund/cancellation deadlines surface in Needs-attention ("Free cancellation on the chalet ends in 3 days — 2 people still unconfirmed"). This crosses booking data with confirmation data — something no mainstream app does.
- **Paste-anything ingestion (AI):** a single "Add from paste/photo" entry point accepting a URL, pasted confirmation-email text, or screenshot → one edge function (`ingest`) classifies (booking / option / event / receipt) and extracts a structured draft the user confirms. Same Zod-schema/structured-output machinery as receipts.

---

## 10. Expenses & receipts v2

### Receipt parsing (rewrite of parse-receipt)
- **Model:** `claude-sonnet-5` for all parsing ($2/$10 per MTok intro until 2026-08-31, then $3/$15) — one model, no escalation tiers (Tim: simplicity over cost-tiering). Drop the GPT-4o-mini fallback (second vendor key, weaker vision) — a single retry on validation failure replaces it.
- **Structured outputs** via `output_config: {format: {type: "json_schema", …}}` with a shared Zod schema — no more prose-prompt JSON hoping. Image placed before text in content; client pre-resizes to ~1500px long edge.
- **Explicit adjustment model** (replaces the flat tax/service columns as source of truth; old columns kept and populated for compatibility):
  - `line_items[]`: qty, unit_price, line_total, **which of the two was printed** (solves the Japanese 単価/金額 ambiguity structurally instead of by prompt heuristics), line-level discounts, original + English names.
  - `tax[]` **array** with rate and `inclusive` flag — handles VAT-inclusive Europe, US add-on tax, and Japan's dual 8%/10% receipts (8%対象/10%対象 subtotals) in one model.
  - `service_charge` (amount/percent, auto vs voluntary), `tip`, receipt-level `discounts[]`, `rounding_adjustment`.
  - `confidence` per field + `notes`.
- **Reconciliation in code, not the model:** Σ(line) = subtotal, subtotal ± adjustments = total, tolerance ±1 minor unit per tax group. On mismatch → one automatic repair re-prompt quoting the discrepancy; still failing → trust printed total, flag lines for user review. Never silently adjust.
- **Adjustment disambiguation engine (v1's #1 pain: service charge & tax detection):** the model must label each adjustment's *provenance* (printed_line | derived | embedded_in_prices) — but code makes the final call by **hypothesis testing**: given Σ(lines) and printed total, test the standard interpretations (all-inclusive; +N% service; +N% tax; tax-inclusive with service added; etc., using common rates 5/8/10/12.5/15/20%) and select the one that reconciles to the exact total. Model opinion breaks ties only. If no hypothesis reconciles, the confirm step shows an **adjustments review panel** with one-tap fixes (service: "included / added on top / none" + percent quick-selects; same for tax) — never free-form number surgery. Target: manual adjustment becomes the rare exception, and takes seconds when needed.
- **Real-world regression corpus:** replay all existing v1 receipts (images in the receipts bucket + their stored `ai_parsed_data` and user-corrected final values in the DB) against the new parser before it ships; every historically-misparsed service-charge/tax case becomes a permanent test fixture (§16).
- **Prompt caching:** static system prompt + schema behind a `cache_control` breakpoint (pad past the 2048/4096-token minimum) — repeat parses at ~0.1× input price.
- New nullable columns on `expenses`: `tip_amount`, `tax_lines` JSONB, `rounding_adjustment`, `place_id`, `booking_id`.

### Splits
- Keep equal / custom / percentage / itemized. Add **shares/weights** (`expense_splits.shares` numeric; extend `split_type` enum with 'shares') — couples count 2×, etc.
- **Split-by-nights-present** (creative differentiator): for accommodation-category expenses, offer a one-tap "weight by nights" that derives each person's nights from their arrival/departure timeline events (fallback: trip dates). Late-arrivers automatically pay less for lodging — a real group-trip fairness pain nothing mainstream solves.
- Tax/service/tip distribute **proportionally to each person's item subtotal** for itemized expenses; largest-remainder method guarantees shares sum exactly to the total.
- Itemized claiming: keep shareable claim links (great for WhatsApp) **and** first-class in-app claiming from Needs-attention; shared dishes split among claimants; live "unclaimed remainder" indicator; organizer one-tap "split remainder equally among non-claimants".

### Entry UX
- Quick-capture: photo → parsed → "looks right?" → done (defaults: payer = you, date = today, split = whole group equally). Refinement (itemize, reassign) can happen later — during dinner nobody wants a 4-step wizard.
- **Natural-language add** via AI: "I paid 4200 yen for ramen for me and Alex" → draft expense (uses trip-chat tool infrastructure, §13).
- Duplicate detection: warn when same vendor + similar amount + same day already exists (also catches double card charges).

---

## 11. FX & currencies

- **`trips.base_currency`** (new column, default 'GBP' backfilling current behavior) — settlement currency chosen per trip at creation. All balances and settlements display in it. This removes the hardcoded-GBP assumption.
- Rates: **lock at expense (payment) date** (ASC 830/IAS 21 convention, matches Tricount), from Frankfurter (ECB, historical to 1999, keyless) → fallback `open.er-api.com` for non-ECB currencies; cached in `fx_rates` (already exists) so each pair/date hits the API once ever. Weekend/holiday → most recent prior business day, **resolved in one tested function** instead of scattered logic.
- **User-overridable rate per expense** ("my card charged X") with `rate_source` = 'manual' recorded; add `rate_source` column.
- Kill "provisional rates" complexity: an expense entered today gets today's latest available rate immediately and is only touched by the nightly job if `fx_rate_date < payment_date` (the existing refresh function simplifies accordingly).
- Currency list opens up beyond the current 7 (any ISO 4217, with the frequent ones pinned); JPY-style zero-decimal currencies handled by the minor-units money module.

---

## 12. Settlement v2

- **Finish what's half-built:** freeze → suggest → record → confirm → done.
  1. Organizer freezes balances (existing `settlement_snapshot` fields) once claims are complete; freezing blocks expense edits (edits require unfreeze, audit-logged).
  2. **Min-cash-flow suggestion** (existing greedy max-creditor/max-debtor util, kept, tested): ≤ n−1 payments, all in trip base currency. Simplification is opt-in per trip (it changes who pays whom — Splitwise learned this).
  3. Each suggested payment becomes a `settlements` row with new `status` column: 'suggested' → 'marked_paid' (by payer) → 'confirmed' (by recipient). Recipient confirmation closes the loop — no more "did you get my transfer?".
  4. Payment-detail helper: users store their preferred rails on their profile (new `users.payment_details` JSONB — bank/PayNow/Revolut/Wise handle, free text); the payment card shows the recipient's details + a copy button.
- **Settle-up nudges** with AI-drafted personalized WhatsApp-ready text (§14).
- Export: settlement summary + full expense ledger as CSV and a clean printable page.
- **Cross-trip carry-over** (creative, cheap): when the same pair has an unsettled balance on a previous completed trip, offer to fold it into this trip's settlement (a linking `settlement_carryovers` table) — friend groups repeat, micro-debts shouldn't.

---

## 13. AI platform v2

### Architecture
- One shared edge-function toolkit (`_shared/`): Anthropic client, Zod contracts, rate limiting, usage logging, prompt-cache helpers. Functions: `parse-receipt`, `trip-chat`, `ingest` (new, §9), `refresh-fx-rates` (no AI), `nudge-draft` (§14).
- **Models:** `claude-sonnet-5` for everything (chat, receipts, ingest, nudge drafts) — one model everywhere, simple. (API notes: no temperature/prefill on the 5-family; use structured outputs / adaptive thinking.)

### trip-chat rewrite: context-stuffing → **tool use**
Today the whole trip is serialized into the system prompt (~15–20K tokens/query). Replace with a slim system prompt (trip header, participants, user role) + **tools**: `get_expenses(filter)`, `get_expense_details(id)`, `get_balances()`, `get_pending_claims()`, `get_itinerary(range)`, `get_options(section)`, `get_confirmation_status()`, `search_places()`. Write tools (organizer, with inline confirmation cards in chat before execution): `create_event`, `update_event`, `delete_event`, `create_expense_draft`, `record_settlement`, `close_poll`, `draft_nudge`. Cheaper, more accurate, and unlocks the roadmap's Phase 2/3 in one design.

### Accessible AI (not a hidden drawer)
- Contextual "Ask" affordances per tab with suggestion chips ("How much do I owe?", "What's unclaimed?", "What's the plan Saturday?").
- Natural-language quick-add from the "+" button.
- **Proactive digest** (opt-in, per trip): a scheduled function composes "Trip Pulse" — polls closing, unclaimed items, deadlines approaching, budget drift — posted to the activity feed / notes; organizer can forward to WhatsApp.

### AI proposals & human approval layer (the write-safety spine)
All AI-suggested modifications — from chat, paste-anything ingestion, or bulk **text dumps** ("here's our WhatsApp planning thread, set up the trip") — flow through one pipeline:
1. AI output is a **structured changeset** (Zod-validated array of proposed actions: create_event, create_option, create_booking_draft, create_expense_draft, update_x…), never a direct write. Stored in a new **`ai_proposals`** table (trip_id, created_by, source_text, actions jsonb, status 'pending'|'approved'|'rejected'|'partially_applied', reviewed_by, applied_at).
2. UI renders each action as a **review card** with per-card Approve / Edit / Discard (and approve-all for the brave). Validation preview runs before apply; invalid actions are flagged, not silently dropped.
3. **Apply executes under the approving user's JWT** (client-side mutation or user-context RPC), so RLS is the enforcement layer — the AI cannot cause anything its human approver couldn't do by hand. The service role never writes user data on the AI's behalf.
4. Guardrails: deletes are never batch-approved (each requires individual confirmation), hard cap ~20 actions per proposal, idempotency keys prevent double-apply, proposals expire after 7 days, every application logged to activity_feed as "proposed by AI, approved by X".
This unifies §9 ingestion and chat write-tools into one reviewed pathway; chat's simple organizer actions (create one event) render the same card inline in the chat thread.

### Rate limiting & cost control (replaces msg/day counting queries)
- **Postgres token buckets:** `rate_limits(user_id, feature, tokens, last_refill)` checked/decremented atomically via a `SECURITY DEFINER` RPC. Per-feature quotas (chat, parse, ingest), organizer > participant. No Redis dependency at this scale.
- **`ai_usage` log table:** user, trip, function, model, input/output/cache tokens, estimated cost per call → spend dashboard for Tim (admin) + **monthly circuit-breaker** (hard stop with friendly message).
- `verify_jwt` on all functions, participant check before any work, per-request `max_tokens` caps, prompt caching everywhere.

---

## 14. Nudges, activity & the organizer console (new — the "chase" killer)

- **`activity_feed`** table (trip_id, actor, verb, entity, metadata, created_at) written by mutations; powers a lightweight per-trip feed ("Alex claimed 3 items", "Poll 'Saturday dinner' closed — Kumo wins").
- **Blockers board** (organizer view): one screen listing every open loop grouped by person — pending RSVPs (with dependency-graph insight), unvoted polls, unclaimed items per receipt, unpaid settlements, unbooked won-polls, expiring cancellation windows.
- **One-tap nudge:** per person or per blocker, AI drafts a short friendly message (with the person's deep link: `/trips/:id/claim/:code` etc.) → **copies to clipboard for WhatsApp**. (Web push ships later as progressive enhancement for installed PWAs, non-EU iOS caveat noted.)
- **Auto-chase engine (no more manual chasing):** a scheduled edge function (`auto-chase`, cron like refresh-fx-rates) scans **every open commitment loop** and **emails each laggard a deep link to their exact action**:
  - unclaimed items on expenses older than the trip's threshold;
  - polls approaching deadline with missing votes (incl. headcount-required restaurant/activity polls — card shows "9 confirmed, 3 unanswered — booking Friday");
  - pending RSVPs near the confirmation deadline;
  - **stated-date conditionals**: someone who said "I'll know by the 14th" (`conditional_date`) gets chased the day that date arrives — their own promise becomes the trigger;
  - **waitlist lifecycle**: when a spot frees (decline/cancel or capacity raise), the first waitlisted person automatically receives a claim offer with an expiry (default 48h, `trip_participants.waitlist_offer_expires_at`, added in a feature migration); unclaimed offers cascade to the next in line; waitlisted users see their live queue position;
  - settlements unpaid after N days.
- **Question deflection:** beyond the AI concierge (§13), the trip brief page carries an **auto-generated FAQ** (arrival/departure, accommodation address + map link, what's booked, current per-person cost, what I owe) rebuilt from live trip data — people ask the app before they ask the organizer. Anti-chaos rules: max 1 chase email per person per day (multiple items bundle into one digest email), max 3 reminders per item then stop and escalate to the blockers board as "needs a personal nudge", per-user opt-out (`users.email_notifications_enabled`), per-trip settings (`trips.chase_settings` jsonb: enabled, delay hours, quiet hours, max reminders). All sends logged in a `notifications` table (dedupe keys enforce the caps).
- **Expense involvement tagging feeds the chaser:** expense creation includes a "who was there?" chip row (defaults to all participants; itemized receipts chase only tagged people; `expenses.participant_ids uuid[]`).
- **Email channel:** Brevo free tier (300/day, verified single-sender, no domain needed) behind a pluggable `EmailSender` adapter; if no `BREVO_API_KEY` secret is set, auto-chase degrades gracefully to queueing WhatsApp-ready drafts on the blockers board. (Setup task for Tim: create free Brevo account, verify sender address, `supabase secrets set BREVO_API_KEY=...`.)
- Deep links: every entity gets a routable URL so nudges and chase emails land people exactly on the action.

---

## 15. Post-trip: the retrospective (new, the payoff)

Auto-generated when a trip hits `trip_completed` and settlement closes: **"Trip in numbers"** — total spent, per category, per person, per day; map of everywhere you went (places layer); receipts gallery; superlatives ("most expensive meal", "cheapest day"); AI-written 5-line trip recap from the timeline. Shareable as an image card. Costs almost nothing to build on v2's data and is the emotional reason the group uses the app again next trip.

---

## 16. Reliability engineering

- **Money-math test suite** (the #1 bug source historically): rounding distribution, itemized reconciliation, FX date resolution (weekends, holidays, future dates, JPY), split-sum invariants (every expense's splits sum exactly to its amount — also enforced by a DB trigger, new), settlement zero-sum invariant.
- **Receipt-parser regression set:** a folder of anonymized real receipts (Japanese conbini, izakaya with 8/10% mix, UK service charge, US tax-added, EU inclusive, discounts, handwritten totals) with expected JSON — run on every prompt/schema change.
- Date/time policy: dates as date-only strings end-to-end (no Date-object timezone drift — the timeline bug class); times stored as local trip-time.
- Edge cases codified: deleted/deactivated participant with expenses (keep rows, show "(left trip)"), expense edits after claims (invalidate affected claims + notify), concurrent claim races (DB constraint + upsert), capacity race on confirm (RPC with row lock), invitation reuse, zero-amount and negative (refund) expenses (**new: allow negative amounts as refunds**), duplicate receipt uploads.
- Sentry on frontend + functions; CI: typecheck, lint, unit, Playwright smoke, then deploy.
- **Security audit (explicit gate before deploy):** review all existing 79 + new RLS policies against a per-table access matrix (who may select/insert/update/delete each table, verified by an automated RLS smoke script running as different test users); storage bucket policies (receipts + documents: owner-write, participant-read, signed-URL TTLs); every edge function verifies JWT + participant membership before any work; service role key never used to write user data (only fx_rates, ai_usage, rate_limits); invitation brute-force lockout (attempts table already exists — add rate check); OTP abuse limits (Supabase built-in email rate limits confirmed); no secrets in frontend bundle (audit `import.meta.env` usage); dependency audit (`npm audit`) in CI.

---

## 17. Schema changes (additive DDL summary)

New tables: `places`, `bookings`, `option_votes`, `reactions`, `activity_feed`, `rate_limits`, `ai_usage`, `trip_checklists`, `settlement_carryovers`, `ai_proposals`, `notifications`.
New columns: `trips.{base_currency, chase_settings}`; `planning_sections.{vote_deadline, quorum, voting_method, hide_votes_until_close}`; `options.place_id`; `trip_timeline_events.place_id`; `expenses.{tip_amount, tax_lines, rounding_adjustment, place_id, booking_id, rate_source, participant_ids}`; `expense_splits.shares`; `settlements.{status, currency}`; `users.{payment_details, email_notifications_enabled}`.
New enum values: `split_type + 'shares'`; settlement status enum (new).
New DB objects: split-sum trigger, rate-limit RPC, RLS policies for all new tables (mirror existing per-trip patterns).

---

## 18. Execution model (subagent workstreams)

No calendar phases — parallel workstreams with contracts, integrated by the coordinator. Order of operations: **backup → migrations+types → contracts → then everything in parallel.**

| # | Workstream | Scope | Depends on |
|---|---|---|---|
| 0 | Foundation | Backup, baseline migration, all §17 DDL, regenerated types, shared Zod contracts, money module, FX date resolver + tests | — |
| A | Design system & shell | Tokens, ui/ kit rebuild, nav (bottom bar/sidebar), stage-aware trip home, Today screen, dashboard, Needs-attention strip, PWA | 0 |
| B | Data layer | TanStack Query hooks per feature, Realtime invalidation wiring, optimistic-mutation helpers, error boundaries, Sentry | 0 |
| C | Lifecycle & decisions | Brief page, confirmation UX + dependency graph, polls/voting, options + paste-a-link, matrix view, reactions | 0, A, B |
| D | Expenses & settlement | Quick capture, wizard decomposition, itemized claims v2, shares & nights-weighting, settlement flow, exports, charts | 0, A, B |
| E | Edge functions | parse-receipt v2, trip-chat v2 (tools), ingest, nudge-draft, rate limiting + ai_usage, refresh-fx simplification | 0 |
| F | Places & maps | places table plumbing, link parsing, geocoding, Leaflet trip map, deep links | 0, B |
| G | Organizer console & activity | activity_feed writes, blockers board, nudge composer, retrospective | C, D, E |
| H | QA & hardening | Test suites (§16), receipt regression set, Playwright, RLS smoke, CI pipeline | all |

Each workstream brief = relevant sections of this doc + the shared contracts. Integration checkpoints after {A,B}, after {C,D,E,F}, then G, then H gates deploy.

---

## 19. Defaults chosen (override anytime)

- Base currency default **GBP** (existing data backfilled as GBP — matches current behavior).
- Keep GitHub Pages + current URL; keep app name "Trips" (rebrand is a find-replace later).
- Leaflet/OSM + Google **links** (no paid Google Maps API).
- WhatsApp-via-clipboard nudges now; web push later; no email infrastructure.
- Claude-only AI (drop OpenAI fallback); `claude-sonnet-5` for all AI features, no model tiering.
- Poll votes hidden until close, by default.
