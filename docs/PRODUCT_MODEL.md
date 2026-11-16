# Product model

How Trips works for the people using it, as built. Code is the source of truth; the file that decides each rule is named so you can check it. Older plans (`UX_REDESIGN.md`, `UPGRADE_MASTER_PLAN.md`, `CONFIRMATION_SYSTEM_PLAN.md`) are historical.

## 1. Vocabulary

Eight nouns, used in every screen and email.

| Noun | Meaning | Stored in |
|---|---|---|
| Trip | The whole thing. | `trips` |
| Plan | What is happening, day by day. An entry is just its title. | `trip_timeline_events`, decided options |
| Question | Something the group needs to settle. **Group choice**: one answer for everyone (people vote). **Own choice**: each person picks for themselves (rental, lessons). | `planning_sections` (`metadata.decision_shape`: absent or vote = Group, `personal` = Own) |
| Option | One possible answer to a question. | `options` |
| Answer | Your response to a question: your vote(s), your picks, or "No preference" (Group) / "None for me" (Own). | `option_votes`, `selections`, `question_passes` |
| To-do | Something one person has to do. | `trip_actions`, `trip_checklists`, plus derived ones |
| Expense | Money someone paid for the group. | `expenses` |
| Payment | Money moving between people to settle up. | `settlements` |

Six statuses:

| Status | On | Means |
|---|---|---|
| Open | question | Taking answers. |
| Decided | question, winning option | The group has an answer. |
| Booked | decided option | A live (non-cancelled) `bookings` row exists, or the legacy `options.status = 'booked'`. |
| Done | to-do | Finished. |
| Needs your answer | question, your side | Open and you have not answered. |
| Answered ✓ | question, your side | You have answered (changeable while Open). |

Modifiers, not statuses: **Overdue** (due chip), **"closes Fri 21 Nov"** (deadline), **"Closed — no decision"** (a question on a Finished trip that was never decided).

**RSVP.** Prompt "Are you coming?", buttons **I'm in** / **Not sure yet** / **Can't make it** (`src/features/people/lib/rsvpLabels.ts`). Seven stored values map to five chips:

| Chip | `confirmation_status` |
|---|---|
| Going | confirmed |
| Not sure | interested, conditional |
| Not going | declined, cancelled |
| No reply yet | pending |
| Waitlist | waitlist |

RSVP only exists on trips with RSVP tracking on (`trips.confirmation_enabled`). With it off, every active participant counts as going. The People space heading reads "Who's coming · N going · M invited"; when the trip has a capacity limit, the capacity card reads "N of CAP places taken · X left".

**Trip stages** (stored `trips.status`, shown with these words): Who's coming (gathering_interest, confirming_participants), Planning (booking_details), Ready to go (booked_awaiting_departure), On the trip (trip_ongoing), Finished (trip_completed). The effective stage is the later of the stored status and what the dates say (`src/lib/tripStage.ts`); it never moves backwards. The daily job also writes the stored status forward when dates say the trip has started or ended (`stageSyncTarget` in `supabase/functions/auto-chase/autoDecide.ts`), with two rules: it never fights a person (if someone changed the status by hand after the relevant date boundary, that is left alone: start 00:00 UTC for On the trip, 00:00 UTC the day after `end_date` for Finished), and Finished waits until the day after `end_date` (UTC) has begun. It never moves a trip backwards, and skips a trip with a missing, odd or inverted date.

## 2. Your to-dos

Today's personal list is headed "Your to-dos". The sheet behind its "Shared to-dos" row is titled "Shared to-dos" and lists only the shared task-type to-dos (not answers, RSVPs or payments).

`computeTodos(snapshot, userId)` in `src/lib/todos/computeTodos.ts` is the only definition. Every count and list in the app and in emails comes from it.

| Kind | Appears when | Done when |
|---|---|---|
| RSVP ("Are you coming?") | RSVP tracking is on and you are pending; or interested and the trip has an RSVP deadline; or conditional and your date has arrived | You reply with a definite answer |
| Answer | An Open question you are asked to answer, with at least one live option, and (for an Own choice) a deadline or pass support | You vote, pick, or pass; or the question is closed |
| Task | A to-do assigned to you, or to everyone, not yet completed. A "Who: anyone" to-do counts only for whoever claims it. Packing/bring items assigned to you | You complete it; or you answer the question it is linked to; closing the question completes it for everyone |
| Pay | Balances are frozen and you have a suggested payment to send; on a Finished frozen trip with no row, "Settle up: you owe £X" | The payment is marked paid |
| Confirm payment | Someone marked a payment to you as paid | You confirm |
| Claim | An itemised receipt you are on, with a usable claim link, where you have claimed nothing; not while balances are frozen; never for the payer | You claim your items |
| Travel details | Before the trip starts (not once it is On the trip or Finished), within 30 days of the start date or once the stage is Ready to go; only for a confirmed person when RSVP tracking is on (with it off, every active person) | You have added both an arrival and a departure (one of the two is not enough) |
| Waitlist offer | You have an unexpired offer for a freed spot | You accept or decline |
| Organiser kinds | See section 3 | See section 3 |

Global rules:

- **Scope.** People who are out (declined, cancelled, or removed) get only money to-dos. Money follows you out.
- **Finished trips.** Only money to-dos remain. Open questions show "Closed — no decision".
- **Deadlines never hide a to-do.** They set the due chip, the overdue flag and the order.
- **Order.** Personal before organiser; then overdue, due date, kind, title.
- **Ideas.** The Ideas list is a place to collect suggestions, not a question. It is never a to-do, never auto-decided, never chased.
- **Not a to-do (information only).** On a Finished trip with balances not yet frozen, a person who owes money gets an info line ("You'll be able to settle up (you owe £X) once the organizer finalizes balances", `src/lib/todos/copy.ts`), which is not counted anywhere.

**Waiting on** (organiser board) is the same engine run for every participant, grouped by person and by thing. A person's count there always equals their own list length.

## 3. Question lifecycle

```
Open  --decide-->  Decided  --mark booked-->  Booked
  ^                    |                          |
  +------- Reopen -----+---- un-book ------------+
```

**Open.** People answer. A Group choice is won by tally (single, approval or ranked voting). "N of M answered" counts every active person who has not declined or cancelled (pending, interested, conditional and waitlisted people are still asked). Votes and passes on a closed question are blocked at the database (`option_votes` trigger, `question_passes` trigger).

**Decide.** One step through `decide_question` (organiser only). It stamps the winner (`metadata.decided_option_id`), can put it on the plan (creates a `trip_timeline_events` row linked by `source_option_id`) and can create a "Book: <option>" to-do for someone. That to-do is deliberately not linked to the question, so it survives the question closing. If the organiser decides a tie, the winner is the organiser's explicit pick. For an Own choice there is no winner: closing just stops answers ("Orders closed").

**Organiser to-dos on a question.**

| Kind | When |
|---|---|
| Decide | Group choice is Open and either everyone has answered or the deadline passed |
| Tie: choose a winner | Deadline passed and the tally is tied (replaces Decide) |
| Close answers | Own choice is Open and its deadline passed |
| Book | Decided, bookable type (accommodation, flights, transport, activities, lessons), trip not yet started, no booking yet, no real "Book:" to-do already linked. At most 3 shown. Never for Trip dates polls |
| Setup | No other participants yet (invite); no questions yet; Finished trip with unfrozen balances (Freeze) |

**Auto-decide.** The daily job (`auto_decide_question`, service role only) decides an Open Group choice at its deadline when all of these hold:

- the deadline passed in the last 48 hours (older ones surface to organisers as a Decide to-do instead)
- the trip is not Finished and the trip has chase emails switched on (`chase_settings.enabled`), and `chase_settings.auto_decide` is not explicitly off
- not an Own choice, not the Ideas list, not a date poll, no booked option, ranked votes all have ranks
- enough in-scope people answered: the question's own quorum, otherwise at least half of the people in scope (rounded up). Only real answers (votes) count toward this; a "No preference" pass does not
- reminders are off by default for every trip (`chase_settings.enabled` absent or false), so auto-decide is off by default too; it only runs while a trip's reminders are on
- exactly one option has the top score. Ties and zero answers are never auto-decided

Auto-decisions are logged as `poll_closed` with no actor and are reversible with Reopen. Everyone asked (minus whoever decided) gets a "We have an answer" email, subject to the gates in section 8.

**Booked.** `mark_booked` sets a live `bookings` row (reference, amount, currency, dates) and completes the "Book:" to-do. `unmark_booked` cancels the booking and can reopen the question.

**Reopen.** Organiser-only. Sets the question back to Open, clears the recorded winner and follow-up link, and keeps all votes. Anything already made from the outcome (plan entry, booking, to-do) is left alone.

### Suggest an option

People who are coming but do not run the trip can add to the group's thinking without organiser help. The rules live in `src/features/decisions/lib/suggestOption.ts` (what the app offers) and are enforced by the RPCs `suggest_option` and `withdraw_suggestion` (`supabase/migrations/20261119090000_suggest_option.sql`).

- **Who.** An active participant of the trip who has not declined or cancelled. Site admins and trip creators who are not on the roster are refused, and organisers do not see the entry (they use Manage > Add option). The client only offers it to a viewer who is on the roster and coming.
- **Where.** An open Group-choice question. Refused: an Own choice question (an order form), a date poll (a question titled "Trip dates" or with dated options), a closed question, and a Finished trip.
- **What is stored.** A title (trimmed, 1 to 120 characters; a whitespace-only title is rejected), an optional note (500 characters at most) and an optional link (http or https only, no spaces, 2000 characters at most). The option has no price, the default status and is not locked; `metadata` records `suggested_by`, `suggested_at` and `source_url`. An activity row `option_suggested` is written. The link is shown with the option as a safe external link (`rel="noopener noreferrer"`).
- **Limits.** No duplicate title (case-insensitive) among live options in the question; 5 suggestions per person per question, 20 per person per trip, 60 options per question. The server takes one lock per trip while it checks and inserts, so two people suggesting at the same moment cannot both slip past a limit or the duplicate rule.
- **Ideas.** An idea from a participant goes into the trip's open Ideas list, created on first use (Choose any, approval, results visible). It is the only way a participant can make a question exist. In the Add flow a non-organiser is offered exactly one intent, "An idea".
- **Label.** The option shows "Suggested by <first name>" ("Suggested by you" for the suggester). Organisers can still edit, price or delete it; editing keeps the `suggested_by` mark.
- **Withdraw.** Only the suggester, while the question is open and the trip not Finished, and only while the option is `available`, not locked, has no vote or selection on it, and nothing has been made from it: withdraw refuses with `option_in_use` if a booking, an expense or a plan entry (`trip_timeline_events.source_option_id`) references the option. Comments and reactions on it go with it.
- **Effect on answers.** A new option has no votes, so it cannot become the sole leader and nobody who already answered becomes "Needs your answer" again.

## 4. Cost model

One formatter prints every amount (`src/lib/money/format.ts`, en-GB): headline mode for glances, exact for ledgers, estimate with a leading "≈". Money is stored and added in integer minor units.

**Price basis** (how to read the number on an option, `src/lib/cost/priceBasis.ts`):

| Basis | Meaning |
|---|---|
| Each person | Everyone who joins pays this |
| Total for the group | One price shared between the people going |
| Per night (whole place) | Price per night, times nights, shared |
| Depends on group size | Total comes from group-size tiers, shared |

Nights come from the option's own nights, then its date range, then the trip dates, else 1 (flagged as unverified).

**Headcount.** One rule, always printed: the in-scope people (`inScopePeople`), shown as "9 going", or "invited" when RSVP tracking is on and the figure is an estimate, or "4 in" for an opt-in cost split among those who opted in.

**Certainty ladder** (`computeOptionPrice`), least to most certain:

| Word | When |
|---|---|
| est. | The option is on an Open question |
| decided | It won a Decided question |
| booked | A live booking with an amount exists, or the legacy booked flag |
| paid | A real expense is matched to it; the expense and your split win |

A total is only as certain as its weakest part.

**Your cost** (`src/lib/cost/yourCost.ts`) answers "what does this trip cost me?":

- Decided question: the winner's price. A live booking replaces it with booking amount divided by headcount.
- Open question with a shared cost (`metadata.cost_scope = 'everyone'`, or by default accommodation, flights, transport, insurance): a min-max range over its priced options.
- Open opt-in question: only options you answered; an unchosen activity adds nothing (counted as optional).
- Own choice: your own picks with quantities and variants.
- Plan entries with a cost add in, without double counting an event made from a priced option.
- The organiser's rough accommodation figure is used only while no accommodation option has a price.
- Expenses linked to the winner or booked option reconcile the line ("£X paid of ≈£Y"). Once the trip is Finished and you are on at least one expense, the card switches to "Your share" with the estimate kept for comparison.
- Other currencies are converted at the latest cached rate and marked "≈"; a currency with no rate is left out and listed.

**Money position** (`src/lib/cost/moneyEquation.ts`) explains itself: you paid, minus your share, minus paid back to you, equals what you owe. Money already marked paid is never in a "You owe" headline; it reads "£X sent, waiting for <name> to confirm". Carryovers are shown as carried over, not as payments.

## 5. Settle up

Statuses of a payment (`settlements.status`, enforced by a check constraint): `suggested` -> `marked_paid` -> `confirmed`.

```
Freeze  ->  suggested  --payer marks paid-->  marked_paid  --payee confirms-->  confirmed
```

| Step | Who | Effect |
|---|---|---|
| Freeze | Organiser, trip creator or site admin (`freeze_settlements`, atomic, one at a time per trip) | Stores a balance snapshot on the trip, replaces old `suggested` rows with new ones. The app locks adding and changing expenses and claims while frozen (a UI rule only; no database trigger enforces it). Blocked while a payment looks recorded twice and one of the pair is still `marked_paid`. The organiser's "Freeze balances" to-do only appears on a Finished trip, and only when someone owes money |
| Mark paid | The app offers it to the payer only, on a suggested row. (Row-level security also lets a trip organiser, and the row's creator within 24 hours, update the row.) | Status `marked_paid`; amount and currency cannot change. Not counted in the balance (`computeBalances` skips it), never shown as still owed, and treated as already sent by freeze and the pre-freeze list for base-currency rows (`withSentPaymentsCounted` in `settleUpLogic.ts`, passed as `p_known_paid_ids`) |
| Confirm | The payee only, on a marked-paid row | Status `confirmed`; counted in the balance. Payment details cannot be edited by the payee |
| Unfreeze | Anyone who `canManageTrip` (site admin, organiser, trip creator) | Clears the snapshot and stamps who/when. Old `suggested` rows stay until the next freeze replaces them, so an unfrozen trip never shows per-payment "Pay" to-dos |
| Remove duplicate | Anyone who `canManageTrip` (`remove_duplicate_settlement`) | Deletes one of two payments recorded twice. Never a confirmed row; needs proof of a twin |

**Duplicates.** Two non-suggested payments with the same payer, payee, amount and currency, created within 24 hours of each other, are treated as a possible duplicate (a hint, since genuine identical payments exist). `computeBalances` does not deduplicate: only the "what is left to suggest" maths counts a marked-paid twin once (`withSentPaymentsCounted`). A re-freeze is blocked only while a twin is still `marked_paid` (the check in `freeze_settlements`), until it is sorted out. Payments days apart are separate instalments. When two identical rows each need action, their to-do titles are told apart by date, note, or "1 of 2".

Marked-paid payments in a currency other than the trip base currency are converted (marked ≈) when a rate exists, otherwise left out of the money-position arithmetic and listed (`src/lib/cost/moneyEquation.ts`). Confirmed payments in another currency are counted 1:1 in the balance (`computeBalances`); settlements are meant to be recorded in the base currency.

## 6. Roles and `canManageTrip`

| Role | Source |
|---|---|
| Site admin | `users.role = 'admin'` |
| Trip organiser | Active `trip_participants.role = 'organizer'` |
| Trip creator | `trips.created_by` |
| Participant | Active `trip_participants` row |

`canManageTrip` = site admin OR active organiser OR trip creator (`src/hooks/useTripPermissions.ts`). Every organiser control in the UI (Manage, Decide, Mark booked, Reopen, Freeze, Add to plan intents) is gated on it. The same rule is enforced server side in the RPCs (`assert_can_manage_trip`, `settlement_assert_can_manage`, `reset_trip_confirmations`). A removed organiser (inactive) loses it. Organiser to-dos are produced for organisers and the creator. The two do not always agree. Some older RLS policies use `is_trip_organizer()`, which has no active filter and does not know about site admins (for example the settlements UPDATE policy), so a site admin who is not on the roster can be offered a control by the UI that the database refuses (`src/hooks/useTripPermissions.ts`), while a removed organiser is not offered it by the UI.

## 7. Deep links

Every to-do and email link is `/{tripId}?open=<target>` (`DEEP_LINKS` in `src/lib/todos/copy.ts`). `src/pages/tripDeepLinks.ts` parses the value (`resolveOpenParam`) and decides where it lands (`planDeepLink`, pure and unit-tested); `TripDetail` applies the result. The params are one-shot: they are removed from the address once handled. An unrecognised `open` value shows the toast "That link didn't open anything." and stays where it is. Links do not all land softly on Today: a stale id usually does (with a toast), but some go to the space that owns the thing, as listed.

| `?open=` | Behaviour |
|---|---|
| `todos` | Today, scrolled to Your to-dos |
| `actions`, `todos-all` | Today, with the "Shared to-dos" sheet open on its to-dos segment. `todos-all` (Today's "Shared to-dos" row) is parsed here but is not in `DEEP_LINKS`, so the engine never emits it; `actions` is the older link from action notes and early emails |
| `actions-bring` | Same sheet on its Bring list segment (older link) |
| `rsvp` | Today, "Are you coming?" sheet; if you are not on the guest list, Today with a toast |
| `question:<id>` | Plan. If the question is open, has a live option and is on your answer list, the answer flow for that question. If it is decided or closed, the trip is Finished, it has no live option, or you have already answered it (or are not asked), the Plan's question card is shown instead (scrolled to and highlighted). A question that no longer exists lands on Today with a toast |
| `answer-all` | Plan, the answer flow over all your open answers; with none, Today and the toast "You're all set" |
| `todo:<id>` | Today, the Shared to-dos sheet with that task highlighted; a missing task lands on Today with a toast |
| `bring:<id>` | The same sheet on the Bring list with that packing item highlighted; a missing item lands on Today with a toast |
| `settle` | Money > Settle up |
| `payment:<id>` | Money. Your own suggested payment opens the mark-paid sheet; a marked-paid payment to you opens the confirm sheet; any other payment opens Settle up. A payment that no longer exists opens Settle up with a toast (not Today) |
| `travel-details` | People, the travel details sheet |
| `item:<id>` | Plan, the item sheet for a plan event or an option; a missing item lands on Today with a toast |
| `claim:<expenseId>` | Money, the itemised claim sheet (emails use the `/claim/:code` page). A receipt that no longer exists lands on Today with a toast; one with no claim link goes to Money with the toast "Claiming isn't open for that receipt." |
| `setup` | Organisers only. Opens the invite sheet when nobody else is on the trip, otherwise the first-question sheet when there are no questions yet, otherwise Today with nothing open. For anyone who is not an organiser, Today |
| `decide:<sectionId>` | Plan, Manage > Decide for one question. Organisers only; for anyone else, a closed question, a Finished trip or a question with no live option, Today with a toast |
| `book:<optionId>` | Plan, Manage > Mark booked for one decided option. Organisers only; otherwise (Finished trip, option already booked, question not decided, Own choice, or a missing option) Today with a toast |

Separate from `open`, the older `?tab=` param still lands on a space: `organizer` or `console` opens the organiser console, `retro` opens the recap, and the legacy ids `brief`, `home`, `today`, `notes`, `checklist` (Today), `decisions`, `timeline`, `map`, `plan` (Plan), `money`, `expenses` (Money), `my-spending`, `settle-up` (Money, straight into that screen) and `people` (People). "Organiser" in the table means `canManageTrip`.

## 8. Emails

Two families. Reminder emails come from the daily `auto-chase` job (09:00 UTC) through one shared template ("Tim's Trip Planner"), bundled into **one digest per person per day**. Account emails come from Supabase Auth and never go through the job.

Gates that apply to every reminder:

- the person has an email, has not opted out (`users.email_notifications_enabled`), and a mail provider (Resend or Brevo) is configured; otherwise the send is logged as skipped
- declined, cancelled and removed people are not chased for anything that asks them to do something
- quiet hours (per trip, UTC) apply; a dedupe key per kind/item/person/sequence stops repeats
- max 3 reminders per item (`max_reminders`), then the item escalates to the organiser's board as "needs a personal nudge"
- planning-phase kinds stop once the trip is Finished; money kinds do not

| Kind | Sent to | Gate |
|---|---|---|
| `unvoted_poll` / `unfilled_order` | Anyone who has not answered a Group / Own choice | Trip chase on; question Open with a deadline in the next 48h; engine agrees it is still their to-do |
| `pending_rsvp` | People who have not replied | Trip chase on; RSVP tracking on; RSVP deadline within 72h |
| `conditional_date_arrived` | Conditional "Not sure" people whose date arrived | Trip chase on; RSVP tracking on |
| `waitlist_offer` | First in line when a spot frees | Trip chase on; capacity limit set |
| `unclaimed_items` | People on an itemised receipt who have claimed nothing | Trip chase on; receipt older than `delay_hours` (default 48); not while balances are frozen |
| `unpaid_settlement` | Payer of a suggested payment | Trip chase on; payment older than 3 days |
| `unconfirmed_settlement` | Payee of a marked-paid payment | Trip chase on; payment older than 3 days |
| `t30_no_transport` | Organisers only, once | Trip chase on; 30 days or fewer to start; no flights or transport on the plan |
| `t14_missing_arrival` | Confirmed people without travel details | Trip chase on; 14 days or fewer to start |
| `t1_checkin` | Whoever booked a flight with a confirmation reference | Trip chase on; the day before the trip |
| `action_due_7d`, `action_due_1d`, `overdue_action` | Assignee (or every active person without a completion) of a dated to-do | On by default for every trip (`chase_settings.action_reminders`, opt-out); not gated by chase on; each stage fires once |
| `decision` ("We have an answer") | Everyone asked (active, not declined or cancelled), minus the decider | Trip chase on and outside the trip's quiet hours (like every reminder above); the trip is not Finished (status or end date); the question is closed with a recorded winner, is a Group choice and not the Ideas list; the winner is not cancelled and still matches the activity row; decided in the last 26 hours (`poll_closed` row). Deduped forever by `chase:decision:<section>:<option>:<user>:1`, so after Reopen the same winner is never announced again (a different winner is) |

"Trip chase on" means `chase_settings.enabled = true`, which is off by default. Account emails: a 6-digit login code and a 6-digit sign-up verification code (templates in `supabase/templates/`, edited in the Supabase dashboard).
