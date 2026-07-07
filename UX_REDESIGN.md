# Trips v2.1 — Ground-Up UX Redesign

**Status:** approved direction (Tim, 2026-07-07). Supersedes the tab layout shipped in v2.0; all other v2 systems (data layer, money, AI, security) unchanged.

## The core insight

A group trip is **one stream of plan items moving through stages of certainty**:

```
idea → proposal (votable) → decided → booked → happening → happened
```

A restaurant being voted on, the Saturday-dinner slot it would fill, its pin on the map, its booking confirmation, and the expense it becomes are ONE thing at different stages — not five features. v2.0 kept them in separate tabs (Plan / Timeline / Map / bookings-in-Console); v2.1 unifies them into a single **Plan** surface with lenses. The schema already supports this (`trip_timeline_events.source_option_id`, `bookings.option_id/timeline_event_id/expense_id`) — this is a frontend recomposition, **no destructive migration**.

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
