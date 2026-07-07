# Trips v3 — Ground-Up Experience Redesign

**Status:** approved direction (Tim, 2026-07-07). Supersedes the tab layout shipped in v2.0; all other v2 systems (data layer, money, AI, security) unchanged.

## The core insight

A group trip is **one stream of plan items moving through stages of certainty**:

```
idea → proposal (votable) → decided → booked → happening → happened
```

A restaurant being voted on, the Saturday-dinner slot it would fill, its pin on the map, its booking confirmation, and the expense it becomes are ONE thing at different stages — not five features. v2.0 kept them in separate tabs (Plan / Timeline / Map / bookings-in-Console); v3 unifies them into a single **Plan** surface with lenses. The schema already supports this (`trip_timeline_events.source_option_id`, `bookings.option_id/timeline_event_id/expense_id`) — this is a frontend recomposition, **no destructive migration**.

## Information architecture (4 spaces + FAB)

Bottom nav: **Today · Plan · Money · People** + center FAB. Everything else folds in.

### 1. Today (home — stage-aware action center)
The answer to "what matters right now", per lifecycle stage:
- **Gathering/confirming:** trip brief (cover, dates, cost band, organizer message, FAQ) + RSVP card + who's-in summary.
- **Planning/booking:** "Needs deciding" queue (open polls with deadlines, your unvoted items first), recent announcements, booking deadlines approaching.
- **Awaiting departure:** countdown, arrival plans summary, checklist, open loops.
- **Ongoing:** today's itinerary (next event + directions deep link), quick capture affordance, running "you owe/are owed", announcements.
- **Completed:** settle-up status card + retrospective entry.
Also absorbed into Today: **Notes/announcements** (a compose affordance + feed section — the Notes tab dies), **activity feed** (collapsed "recent activity" section), and for organizers a compact **action strip** (top 3 blockers, link to full Console which becomes a sheet/screen reached from Today, not a tab).

### 2. Plan (the unified surface — replaces Plan + Timeline + Map tabs)
One scrollable **day-by-day board** from trip start to end:
- Each day shows its items in time order. An item renders by stage: **decided/booked** = solid card (time, title, place chip, booking status chip, linked-expense chip); **proposal** = voting card inline in the day it would occupy (options, votes, deadline chip, cost-impact); **idea** = muted card.
- **Undecided tray** pinned above day 1: proposals/ideas with no date yet (e.g. "pick accommodation" section-polls), each with a "schedule it" affordance when decided.
- **Lens switcher** (segmented, sticky): **List** (default, above) · **Map** (same items as pins, day-colored, tap pin → same item card) · **Decide** (only open votables, sorted by deadline — the "do your homework" view).
- Item detail sheet unifies everything about one item: description, place + map thumb, votes/results, booking fields (ref, cancellation deadline), linked expense, comments/reactions.
- Creation: FAB → "Add to plan" (one form: title, optional day/time, optional place, optional price, "make it a vote?" toggle which attaches options) — the option/event distinction disappears at creation time; storage routing happens underneath (votable → planning_sections/options; direct → timeline event).
- When a poll closes/decides: one-tap "put it on the plan" (creates event with source_option_id; already-dated proposals auto-place).

Under the hood: a `usePlanItems(tripId)` composition hook merges timeline events + sections/options(+votes) + bookings into `PlanItem[]` with a `stage` discriminator. Sections remain the votable-group mechanism; the section list UI (accommodation/flights/etc.) becomes categories INSIDE the Undecided tray, not a separate screen. Matrix view stays, reached from a section's tray card.

### 3. Money (unchanged hub)
Expenses · Settle up · My spending. Keep as shipped in v2.0.

### 4. People
RSVP funnel as shipped (status groups, dependency graph, waitlist) PLUS **travel details** per person (arrival/departure date+time, optional flight no → auto-creates their timeline events, feeds nights-weighting), and the checklist moves here ("who's bringing what" is a people thing). Organizer confirmation settings stay here.

### Chat/AI
Unchanged: header "Ask" + FAB action, proposal review cards. Suggestion chips updated for new IA.

## Avatar system v2 (replaces the emoji builder as primary)

- **Three avatar types**, stored backward-compatibly in existing columns — old data keeps working, nothing migrated destructively:
  1. `upload`: user photo → new public-read `avatars` storage bucket (user-writable own folder, 512px center-crop, compressed ≤200KB via existing browser-image-compression path) → `users.avatar_url` (column exists, mostly unused).
  2. `icon`: curated set of **~28 travel/holiday-themed flat SVG icons** designed in-repo (mountain, snowflake, palm, wave, compass, backpack, camper, sushi, croissant, cocktail, hot-spring, cable-car, passport, polaroid, campfire, sailing, skis, onsen, torii, lighthouse, cactus, aurora, hot-air balloon, coconut, gondola, tent, surfboard, world-map…) × token background colors, stored as `avatar_data: {type:'icon', icon:'mountain', bgColor:'…'}`.
  3. `emoji` (legacy): existing `{emoji, accessory, bgColor}` blobs keep rendering exactly as before.
- `Avatar` component resolves: avatar_url → icon → legacy emoji → initials. One resolver, used everywhere.
- Profile sheet: tabs "Photo / Icons / Emoji(legacy)" — first open after upgrade shows a gentle "give your avatar a refresh" hint. No forced migration.
- Migration file: `avatars` bucket + RLS (own-folder write, public read) — additive.

## Systemic layering (z-index) fix — bug class, not bug

Symptom: scrolled content (e.g. timeline sticky day headers, cards with shadows/transforms) renders OVER the app header/nav. Root cause class: ad-hoc `z-*` utilities and stacking contexts created inside tab panels competing with chrome that has no explicit layer.

**The rule (enforce everywhere):**
1. App chrome (Header, bottom TabBar, sidebar) sits at `z-[var(--z-sticky)]` (1100), always.
2. NOTHING inside tab content may exceed `z-30`: in-content sticky elements (day headers, section headers, lens switcher) use `z-10`–`z-30` and must live in the content scroll container (which is `position:relative`, creating one bounded stacking context under the chrome).
3. Overlays (Modal/Sheet/Toast/popover) keep the token scale (1200+), portal-rendered to body — never nested in content.
4. Audit: grep every `z-` usage in src/, map to the token scale, fix violators; add the rule to UPGRADE_MASTER_PLAN §5 and a lint-ish check (script greps for `z-[4-9][0-9]`/`z-[0-9]{3,}` outside chrome/overlay components).

## What dies
Tabs removed: Timeline, Map, Notes, Checklist (content relocated as above). Console demoted from tab to Today-launched screen. The tab strip disappears on mobile (4 spaces fit the bottom bar exactly); desktop sidebar lists Today/Plan/Money/People + Console (organizers).

## Non-goals (unchanged)
Money hub internals, auth, receipts/AI pipeline, settlement, security posture, admin panel, retrospective content (entry point moves to Today).

---

# Part 2 — The journey layer (login → act → leave)

Sessions are triggered (nudge link, on-trip need, organizer admin, settling), not spontaneous. Optimize land → act → leave.

## Landing rules
- Login/app-open with ONE active (non-completed) trip → land directly in that trip on its stage-default space, Today's "your turn" stack on top. Multiple active trips → dashboard, cards ordered: active-with-your-actions (badge counts) → active → upcoming → past (collapsed). Zero active trips → dashboard.
- Deep links survive auth: protected-route redirect must round-trip through BOTH password and OTP login paths to the exact original URL (verify + test; claim links are the critical case).
- "Your turn" principle on every space: lead with the user's open actions for that space (Today: all of them; Money: owe/claim; People: RSVP; Plan: votes), content below.

## Trip creation → guided setup (organizer)
Replace CreateTripModal fields-dump with a 3-step wizard (Form Standard): (1) name + location + cover accent; (2) dates — segmented "We know the dates" (date pickers) vs "Let the group vote" (creates a 'Trip dates' date-poll section with N candidate ranges; trip start/end nullable-in-spirit: store the earliest candidate as placeholder and flag `chase_settings.dates_pending=true` in jsonb — no schema change); (3) optional per-person cost band + is_public. On create → land on trip with a dismissible NEXT-STEPS card on Today: Invite people (→ invite sheet) → Set the brief (→ confirmation settings) → Start the accommodation vote (→ Plan Undecided tray template). Date-poll close → one-tap "set trip dates from winner".
- Section templates on first Plan visit (organizer, empty state): one-tap create "Accommodation / Getting there / Activities" sections.

## Invite → join funnel
- Invitation links open a PUBLIC read-only trip teaser BEFORE signup: new route /join/:code → SECURITY DEFINER RPC `get_invitation_preview(p_code)` (additive migration) returning {trip name, location, dates, cover accent seed, estimated cost band, confirmed_count, organizer first name} for valid codes only. CTA "Join this trip" → OTP-first signup with code pre-filled (exists) → RSVP card immediately after (skip dashboard).

## Today layouts per stage (the home)
- Invitee/pre-commit: brief hero (cover, dates, cost band, organizer message) → "Are you in?" RSVP card → who's-in avatar row → FAQ.
- Planning: "Your turn" stack (votes by deadline, claims) → announcements (composer inline for organizer) → "decided so far" mini-summary (top 3 plan items + per-person running cost) → organizer blockers strip (top 3 + Nudge all → Console screen).
- Awaiting departure: countdown hero → your arrival details prompt (if missing) → key bookings summary (with cancellation Deadline chips) → checklist nudge → announcements.
- Ongoing: NOW/NEXT card (current/next plan item, place, Directions deep link) → today's items → quick-capture affordance → "you owe/are owed" chip → announcements.
- Completed: settle status card (your net, one-tap to Money/Settle) → recap teaser card (→ retrospective).
- Notes tab dies: announcements/notes render in Today feed with composer; activity feed = collapsed section at bottom.

## People additions
- Travel details per participant: arrival/departure date+time+optional flight/train ref, self-service; writes trip_timeline_events (category transfer/flight, participant_ids=[self], metadata.travel_details=true) so they appear on Plan and feed nights-weighting automatically. Missing-details prompt on Today pre-departure.
- Checklist moves here (tab dies).

## Console demotion
Organizer Console = full-screen sheet launched from Today's blockers strip and header overflow — not a nav tab.

## Navigation (final)
Mobile bottom bar: Today · Plan · Money · People + FAB (context-aware: Today=stage-smart default action, Plan=Add to plan, Money=Scan receipt, People=Invite). Desktop sidebar: same four + Console (organizer). In-page tab strip REMOVED. Map/Decide live inside Plan as lenses; retro/console/chat are launched surfaces, not tabs.

---

# Part 3 — Date intelligence, edge cases, ambient AI

## Date-derived presets (rendered, not stored — self-update when inputs change)
- Plan board anchors: Arrival/Departure day markers; "Day N of M" labels; during trip_ongoing a progress indicator.
- Derived milestones from data: accommodation booking → check-in/check-out banners spanning its dates; flights → airport-day markers; each derived item has one-tap "materialize" (becomes a real editable event).
- T-minus nudges feed the existing chaser (kinds added to auto-chase): T-30 no flight/transport booking → organizer nudge; T-14 missing arrival details → per-person; T-1 check-in reminder if flight booking has ref. All respect chase_settings.
- Countdown: Today hero pre-trip; dashboard TripCard chip; Day-N-of-M during.

## Calendar edge cases (handle explicitly)
1. Dates changed after planning: events/bookings outside new range → flagged "outside trip dates" on Plan with re-anchor affordance; never auto-deleted/moved.
2. No dates yet (date poll pending): board renders relative Day 1..N (longest candidate range); anchors to real dates when set.
3. Multi-day items (accommodation, rentals): render as a span banner across covered days, once.
4. Overnight events (end_time < start_time): assume next-day end, label "→ next day".
5. Long trips (>14 days): collapse full weeks with expand; short/1-day trips: skip day grouping chrome.
6. Pre/post-trip expenses (deposits, refunds): always included in money math and recap; Plan ignores them; My Spending groups as "before the trip".
7. Late arrival / early departure: travel details outside others' range is normal — powers nights-weighting; Today's NOW/NEXT is per-user filtered by their presence window when travel details exist.
8. Times are destination-local naive; UI labels "local time"; flights show departure local time; no TZ conversion ever.
9. Trip cancellation: out of scope (no enum value) — organizer guidance: set is_public=false + announce; revisit if needed.

## Ambient AI (extends the ai_proposals pipeline; nothing writes silently)
1. **Share target ingestion**: PWA manifest `share_target` (POST, text/url/files) → /share route → authenticated user picks trip (if >1 active) → ingest edge function → proposal cards. Android: share from Gmail/Booking/Airbnb apps directly. iOS fallback: paste/photo (existing).
2. **AI autonomy dial** (per trip, organizer setting stored in trips.chase_settings jsonb: ai_autonomy 'suggest'|'auto_own_uploads', default 'suggest'): auto_own_uploads = create-only actions from the uploader's OWN ingest with validation-clean high-confidence parses apply immediately under their JWT, activity-logged "(auto-applied)", one-tap Undo (delete created entity) for 24h. Deletes/updates NEVER auto-apply.
3. **Companion suggestions** (rule engine + AI details, dismissible cards on Plan/Today): flight booking → suggest airport transfer near landing time; accommodation → suggest check-in/out events if not present; dining reservation at time T → suggest onto that evening + TIME-CLASH flag when overlapping an existing item; new booking with dates outside trip range → mismatch flag. Dismissals persisted (localStorage per trip is fine).

## Trip status: derived, suggested, never nagging (Part 2 addendum)
Stored `trips.status` stays (chaser/queries read it) but the UI runs on `effectiveTripStage(trip, today)` in one shared lib:
- effective = trip_ongoing when start_date ≤ today ≤ end_date; trip_completed when today > end_date — regardless of stored value (max of stored vs date-derived; never goes backwards).
- All stage-driven UX (Today variant, default space, StageRail, FAB defaults) uses effective stage.
- Stage-advance SUGGESTION cards on Today (organizer, one-tap apply → updates stored status, activity-logged; dismissible): confirmations enabled → confirming_participants; first booking recorded → booked_awaiting_departure (from booking_details); all non-declined participants confirmed → booking_details (from confirming). Date-driven stages need no suggestion (effective handles behavior) but a low-key "mark as ongoing/completed" sync card keeps stored status honest for the chaser.
- Manual override remains in trip settings; the edit-trip status dropdown disappears from the primary flow.

---

# Part 4 — V3 experience completion (shapes we stop inheriting)

## Money: balance-first, no inner tabs
One screen: (1) position header — "You're owed £84" / "You owe £42 → Settle" / "All square ✓" with per-person breakdown expander; (2) filter chips (All · Mine · Unclaimed · by category); (3) day-grouped expense feed; (4) Settle-up renders as a STATE — a prominent flow card when balances are frozen/being settled or trip completed, not a tab; (5) "My spending" analytics = a screen pushed from the position header ("see my breakdown"), not a tab. EXPENSE_TAB_CONFIGS collapses to one MoneySpace component.

## Decisions: questions, not sections
Everywhere users see decision UX, the language and shape is "open questions": "Where are we staying? · 4 options · closes Thu". Sections remain the storage grouping but never appear as UI chrome; creating a question = AddToPlan with vote toggle (exists) or a "New question" affordance in the tray. Section templates become suggested QUESTIONS ("Where are we staying?", "How are we getting there?"). Matrix stays as an option-display mode within a question.

## RSVP: three human answers over seven statuses
Participant-facing status picker: I'm in (→confirmed, terms/capacity as now) · Can't say yet (→ follow-up: "waiting on a date?" date→conditional-date / "waiting on someone?" people→conditional-users / "just thinking"→interested) · I'm out (→declined; cancelled when previously confirmed). Waitlist/pending surface as system states, never choices. Organizer views keep full 7-status fidelity (groups, graph, waitlist queue). Same table, same enum — presentation layer only.

## Motion & identity system
- Motion tokens in index.css: --ease-spring, durations; sheet enter/exit springs; day-swipe (horizontal pan) between Plan days on mobile; press-scale feedback on cards/buttons (transform 0.98, fast); list item enter stagger (subtle, ≤150ms total); reduced-motion media query respected throughout.
- Illustration identity: extend the 28-icon flat style into ~8 empty-state/hero illustrations (empty plan, no expenses yet, all settled, retrospective header, join teaser cover fallback, nothing-to-decide, offline, error) as in-repo SVG components — consistent stroke/palette with the avatar icons.

---

# Part 5 — Decision shapes (the Meribel lessons) + focused answering

Real trips have THREE decision shapes; forcing all into "options you vote on" creates unreadable lists. Shape lives in planning_sections.metadata jsonb (ADDITIVE migration: add metadata column) as {decision_shape: 'vote'|'personal'|'vote'} with tier data on options.

## Shape 1: Group vote (default — unchanged)
One winner for everyone. Existing voting/deadline/quorum machinery.

## Shape 2: Personal pick (order form — NOT a vote)
For rental gear, lessons, add-ons: organizer defines a CATALOG (options = catalog entries; option.metadata.pricing {per_day?: number, flat?: number, variants?: [{label, per_day|flat}]}); each participant fills THEIR order via a focused sheet: tick items (+variant), date range per item DEFAULTING to their travel-details presence window (else trip dates), live "Your rental: £86" total. Stored as selections rows with metadata {start_date, end_date, variant, quantity}. No votes, no deadline pressure beyond section deadline (chaser: "you haven't filled your rental order").
- Participant view: only their own order + total. Others' picks visible in a compact "who's ordered" avatar row (n/M done).
- Organizer view: consolidated matrix (people × items, dates), per-item counts, group total, and "Copy order sheet" (plain-text summary for the vendor/WhatsApp).
- Per-person cost estimate feeds from their own order.

## Shape 3: Tiered group pricing (headcount-dependent)
option.metadata.price_tiers: [{max_people: 6, total: 300}, {max_people: 12, total: 450}] (price_type 'total_split'). Cost engine picks the applicable tier from the RELEVANT headcount (confirmed count, or opted-in count for optional activities): "≈£50/person at 9" + sensitivity line "£75/pp if 6 · £38/pp if 12". Live-updates as RSVPs/opt-ins change. Winner's booking uses the final tier.

## Focused answer flow (glanceability fix)
- Decide lens = "N things need you · ~X min" entry → question-by-question stepper: one focused screen per open question (vote options OR personal order form), Skip/Next, progress dots, done-state 🎉. No more scrolling walls.
- Question cards everywhere show response-state chips: "You're done ✓" / "Needs you" / "4 of 9 answered", so a glance tells whether you're needed.
- Plan tray question rows collapse to one line each (question + state chip + deadline); expansion happens in the focused flow or item sheet.

## Estimator integration
Per-person trip estimate (Today/brief cost band) = accommodation share + own personal orders + tier-aware share of decided group choices + band (min/max across open questions' cheapest/priciest outcomes).
