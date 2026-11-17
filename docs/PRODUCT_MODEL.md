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
| Confirm payment | Someone marked a payment to you as paid, and you have not said it hasn't arrived | You confirm (or say "It hasn't arrived", after which this to-do is gone: you have answered) |
| Respond (`respond_payment`) | You marked a payment as paid and the receiver says it hasn't arrived (`settlements.receipt_disputed_at` set) | You tap "I've sent it — ask again" or "Undo — I haven't paid yet", or the receiver confirms. Shown to the organizer in Waiting on under the payer, with "— N days" once older than 3 days. The daily job never emails it |
| Claim | An itemised receipt you are on, with a usable claim link, where you have not claimed anything yourself; not while balances are frozen; never for the payer. Only a row you made yourself counts as claimed: your own row, or a shared row you toggled (`created_by` = you). A row that only holds a share of the leftovers (`source` `leftover`, no quantity of your own), or a row someone else put down for you (`on_behalf`, or `shared` by someone else), does not clear it | You claim your items |
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

Statuses of a payment (`settlements.status`, enforced by a check constraint): `suggested` -> `marked_paid` -> `confirmed`. While `marked_paid` a payment can also carry the flag `receipt_disputed_at` (the receiver said it hasn't arrived and the payer has not answered yet), and the payer can take it back to `suggested`. See "Not received" below.

```
Freeze  ->  suggested  --payer marks paid-->  marked_paid  --payee confirms-->  confirmed
```

| Step | Who | Effect |
|---|---|---|
| Freeze | Organiser, trip creator or site admin (`freeze_settlements`, atomic, one at a time per trip) | Stores a balance snapshot on the trip, replaces old `suggested` rows with new ones. The app locks adding and changing expenses and claims while frozen (a UI rule only; no database trigger enforces it). Blocked while a payment looks recorded twice and one of the pair is still `marked_paid`. In the app Freeze and Unfreeze are also paused while any payment is flagged "hasn't arrived" ("A payment is in question — sort that out first", with a "Show me" link to the row); a UI rule only, the freeze functions are unchanged The organiser's "Freeze balances" to-do only appears on a Finished trip, and only when someone owes money |
| Mark paid | The app offers it to the payer only, on a suggested row. (Row-level security also lets a trip organiser, and the row's creator within 24 hours, update the row.) | Status `marked_paid`; amount and currency cannot change. Not counted in the balance (`computeBalances` skips it), never shown as still owed, and treated as already sent by freeze and the pre-freeze list for base-currency rows (`withSentPaymentsCounted` in `settleUpLogic.ts`, passed as `p_known_paid_ids`) |
| Receipt email | Automatic, the moment a payment becomes `marked_paid` (payer marks it, or an organizer records it on their behalf) | The receiver gets a short email "<Payer> paid you £X for <Trip>" (it says so if an organizer recorded it) with two buttons, "Yes, I received it" and "I haven't received it". See section 8. Rows that go straight to `confirmed` send nothing to the receiver |
| Not received (receiver) | The receiver, from the email or from "It hasn't arrived" on the row in Settle up (quiet, next to "Confirm received") | Sets `receipt_disputed_at`; the payment stays `marked_paid`; the payer is emailed once per dispute round. The receiver sees "You said this hasn't arrived — waiting for <Payer>" and can still confirm if it turns up |
| Ask again (payer) | The payer or anyone who can manage the trip, on a disputed row: "I've sent it — ask again". ONLY through `payment-notice` event `re_ask`: a payer who PATCHes the flag to null directly is refused by the database (the guard accepts the payer's clear only from the service role) | One atomic database call clears the flag AND issues a NEW link, then the email "<Payer> says they've sent £X — can you check again?" goes out; if the email cannot be sent the flag is put back. At most 2 re-asks per payment ever ("You've already asked twice — ask an organizer to help"). The app says "We've asked <Receiver> to check again" only when the function answered 200 |
| Retract / undo (payer) | The payer, on ANY of their `marked_paid` rows (flagged or not): a quiet "Undo — I haven't paid yet" (confirm dialog "This undoes 'marked as paid'. <Receiver> will be told."; when an organizer recorded it for them it says so). Anyone who can manage the trip can also retract, from a disputed row | `marked_paid` -> `suggested`; for the payer, payment method, note and paid date are reset (an organizer's reversal keeps any of these they explicitly set in the same update); the flag is cleared; the database stamps `settlements.last_retracted_at` (nobody can set it directly); the receiver is emailed "<Payer> hasn't paid the £X yet — they'll mark it paid when they have"; old email links die. The payer can mark it paid again later, which sends a normal paid notice again iff no paid/re-ask notice has been sent since `last_retracted_at` (at most 4 paid-type notices per payment) |
| Confirm | The payee only, on a marked-paid row | Status `confirmed`; counted in the balance. Payment details cannot be edited by the payee |
| Confirmed notice | Automatic, when the receiver confirms a payment themself (in the app or from the email) | The payer gets a one-line email "<Receiver> confirmed your £X" ("you're square for <Trip>" when nothing else is owed). Not sent when an organizer confirms on the receiver's behalf, nor in "Mark everything as settled" |
| Settle on their behalf | Anyone who `canManageTrip` (active organiser, trip creator, site admin), from a quiet "⋯" menu on each unfinished payment row | `suggested`: "Record as paid" (-> `marked_paid`) or "Record as paid and received" (-> `confirmed`); `marked_paid`: "Confirm received on <receiver>'s behalf" (-> `confirmed`). Never touches amount, parties or currency; a transition is applied only from the status the screen saw. On a frozen trip a "Mark everything as settled…" button lists every unfinished payment, then confirms each one to `confirmed`, row by row (failures are reported per row, successes stay; blocked while a payment looks recorded twice). Every change writes an activity entry `settlement_recorded_on_behalf` (payer, receiver, amount, from and to status) under the actor's name, and the row shows "Recorded as paid ... by <name> on <date>"; there is no column on `settlements` for this, so the activity feed is the record. No migration: the live guard trigger lets `is_trip_organizer()` through, so organisers on the roster update directly; a creator or site admin who is not on the roster is refused by the database and sees the per-row error. When every payment is `confirmed` Settle up says "Everything is settled ✓" |
| Unfreeze | Anyone who `canManageTrip` (site admin, organiser, trip creator) | Clears the snapshot and stamps who/when. Old `suggested` rows stay until the next freeze replaces them, so an unfrozen trip never shows per-payment "Pay" to-dos |
| Who creates a payment record | Only people who can manage the trip (active organiser, trip creator, site admin) and the service role, via the freeze (`freeze_settlements`, or its client fallback) or a prepayment an organiser records. Enforced by the `trigger_guard_settlement_insert` database trigger (amount must be above zero and below 100,000,000 for everyone; an ordinary participant is refused whatever status they send). Payers mark an existing `suggested` payment as paid; receivers confirm | Needs migration `20261120100000_settlement_insert_guard.sql`. `settlements.status` now defaults to `suggested` |
| Remove duplicate | Anyone who `canManageTrip` (`remove_duplicate_settlement`) | Deletes one of two payments recorded twice. Never a confirmed row; needs proof of a twin |

**Duplicates.** Two non-suggested payments with the same payer, payee, amount and currency, created within 24 hours of each other, are treated as a possible duplicate (a hint, since genuine identical payments exist). `computeBalances` does not deduplicate: only the "what is left to suggest" maths counts a marked-paid twin once (`withSentPaymentsCounted`). A re-freeze is blocked only while a twin is still `marked_paid` (the check in `freeze_settlements`), until it is sorted out. Payments days apart are separate instalments. When two identical rows each need action, their to-do titles are told apart by date, note, or "1 of 2".

Marked-paid payments in a currency other than the trip base currency are converted (marked ≈) when a rate exists, otherwise left out of the money-position arithmetic and listed (`src/lib/cost/moneyEquation.ts`). Confirmed payments in another currency are counted 1:1 in the balance (`computeBalances`); settlements are meant to be recorded in the base currency.

**Confirm by email.** The email has two buttons that open the public page (no sign-in): "Yes, I received it" -> `/confirm-payment?t=<token>&a=yes` and "I haven't received it" -> `...&a=no`. `a` is only a hint for the page; the server never reads it, and opening either link changes nothing. The page loads with that answer pre-selected, shows "<Payer> says they paid you £X for <Trip>" and ONE large button ("Yes, I received £X from <Payer>" or "Tell <Payer> it hasn't arrived") plus a small "Change my answer" link. With no `a` it shows both explicit buttons. With no `t` at all it says "This link is missing its code — open the email again or open the app". "Yes" makes the payment `confirmed` (activity `settlement_confirmed_by_email`). "Not received" keeps it `marked_paid`, stamps `receipt_disputed_at`, emails the payer and writes activity `settlement_receipt_disputed`; the page then says "Thanks. We've told <Payer>." Opening a used link later shows the CURRENT truth: "You told <Payer> it hasn't arrived" (still disputed), "<Payer> says they've sent it — check again" (the payer asked again; this old link has no power, the NEW email has fresh buttons), "This payment was undone by <Payer>" (retracted) or "Confirmed". Settle up shows the payer and organizers "Receipt request emailed to <receiver> on <date>" (from the activity row `settlement_receipt_requested`). Expired, already-used and changed payments get a plain message and a link to the trip.

### Receipt claiming (who had what)

**Who may do what** (database: `set_receipt_claims`, `share_receipt_leftovers`; screen: the claim page and "Who had what").

| Who | May |
|---|---|
| The payer, a trip organizer, the trip creator, a site admin | Put any tagged people on any line (equal split), mark a line "shared by everyone at the table", take people off, replace a line wholesale, share the leftovers (everyone, one person, or the payer). |
| A person tagged on the receipt (neither of the above) | Claim their own whole units with the stepper, and **toggle themselves only** on a line that others hold: "I had some of this too" (add me) or "Not mine" (take me off). They cannot add, remove or swap anyone else, cannot touch a "shared by everyone" line, and cannot join a line where somebody else holds rows that are not an exact equal split (a direct "2 of 3 beers", an old 0.33 share): the re-split would rewrite that person's amount. |
| Anyone else | Nothing. Nobody can edit claims while balances are frozen. |

**One row per person and line** (the live unique key `unique_user_claim_per_item` stays). `source` (`self`, `on_behalf`, `shared`, `leftover`) says how the row was FIRST made. A person's share of the leftovers is a PART of that same row, recorded in `leftover_quantity` / `leftover_amount` (the rest of `quantity_claimed` / `amount_owed` is their own claim); a person with no row on the line gets a new `leftover` row. Sharing the leftovers again first takes the old parts back out (a row with nothing of the person's own left is deleted), so it never doubles. A money-only remainder (no whole hundredth of quantity) is merged into the person's row on that line, else added to their largest row on another line of the receipt, else (pure dust) left with the payer's pending bucket; a row never has zero quantity. A client cannot choose how a row is recorded: `source`, `created_by` and the leftover parts are set by the database (direct writes are always `self` with no leftover part; an old cached client loads a person's claim INCLUDING the leftover part and re-inserts it as their OWN claim, so that leftover share becomes permanently "own"; sums stay exact and a later `same` re-share recomputes the leftovers from the new own parts. Shipping the new front end before the migration is not required for safety), and a direct write that would claim more of a line than exists (more than quantity + 0.011) is refused. A direct write is also refused when its `expense_id` is not the line's expense, and while the trip's balances are frozen (hints `bad_expense`, `frozen`; deleting a claim stays possible). **Once leftovers are shared every line is full**, so a person cannot add an own claim until the payer or a manager reassigns the line or re-shares; the claim page says "Everything on this receipt has been shared out - ask <payer> if something's wrong" instead of offering steppers that would be refused ("Not mine" stays available). After any claim save on a receipt that has leftovers shared, the payer or a manager's client re-shares (`same`); for an ordinary person's edit the receipt visibly returns to "has unclaimed value" for the payer. People who stay on a line keep their original `created_by` when it is re-split.

**Tagged** = `expenses.participant_ids` when set; otherwise the people in scope for the trip (active; with confirmation tracking on, not declined or cancelled, and only the confirmed ones once anyone has confirmed).

**Dust tolerance (one constant, 0.011, in the app and the database).** A line counts as unclaimed when more than 0.011 of its quantity is left, or when the money left is more than `max(1, claim rows) + ceil(|line total| x 0.011 / quantity)` minor units. Old rounding (0.33 x 3 of a line) therefore never blocks a freeze. The receipt is then netted against what the payer has pending. A foreign-currency receipt with no exchange rate is judged in its own currency. Both sides run the same cases (`src/features/expenses/lib/unclaimedParityCases.json`).

**Leftover modes** (what happens to unclaimed value): `everyone` = a plain equal split between everyone tagged, pennies to the lowest ids (phase 1: nobody is singled out; the "That's everything" confirmations that cap light eaters come in phase 2), `person` = one named person covers it, `payer` = the payer covers it, `same` = repeat the last mode (stored on the expense, never read from the activity feed). Line totals cannot be negative (no discount lines exist; a zero-total line carries no money, is never unclaimed, and its quantity can still be claimed). The freeze is refused while any receipt has unclaimed value (`unclaimed_receipts`), or an over-claimed line (`overclaimed_receipts`); the error carries the receipt ids and the app shows them with a Refresh button if its own list disagrees.

**`expenses.status` and the live trigger.** A database trigger sets `expenses.status` after every claim insert or update with an exact quantity comparison; it cannot be replaced from here. The claim functions finish with the dust-tolerant status (`allocated` / `pending_allocation` / `unallocated`, never `confirmed` or empty), and nothing decides "unclaimed" from the column: the app, the to-dos and the reminder jobs use the dust-tolerant check on the claims themselves. After an old client's direct write the column may read `pending_allocation` on a receipt split in thirds; that is cosmetic.

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

`/confirm-payment?t=<token>` is a separate public route (not an `open` target): the email button for confirming a payment, see sections 5 and 8.

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

### Payment emails (sent right away, not part of the digest)

| Kind (`notifications.kind`) | Sent to | Gate |
|---|---|---|
| `payment_paid_notice` | The receiver, when a payment becomes `marked_paid` | Not gated by the trip's reminder switch (it is a transactional notice). The receiver has an email, has not opted out (`users.email_notifications_enabled`), a mail provider is configured; payer is not the receiver; the row still exists and is still `marked_paid` when the function runs; the caller is the payer or can manage the trip. Never to the payer |
| `payment_confirmed_notice` | The payer, when the receiver confirms | Same gates; the payment is `confirmed`; sent only when the receiver confirmed it themself (in the app or by email), never for an organizer's on-behalf or batch confirmation. It says "you're square" only when the trip is frozen, the payer has no other unfinished payment (to make or to receive) and no carryover involves them; otherwise just "<Receiver> confirmed your £X" |
| `payment_disputed_notice` | The payer, when the receiver says it hasn't arrived (confirm page or "It hasn't arrived" in the app) | Same gates; the payment is still `marked_paid` and flagged. Subject "<Receiver> says they haven't received your £X yet". One per dispute round (none sent since the latest paid or re-ask notice), at most 6 per payment |
| `payment_reask_notice` | The receiver, when the payer taps "I've sent it — ask again" | Same gates; the payment is `marked_paid` and flagged; at most 2 per payment ever. Subject "<Payer> says they've sent £X — can you check again?". Carries a NEW token and the same two buttons. If the receiver cannot be emailed (switch off, no address, no provider) the flag is still cleared and the re-ask still counts, and the caller sees a normal success; if a cap would block the email (daily cap, or 4 paid-type notices already) NOTHING changes and the answer is 409 `capped` |
| `payment_retracted_notice` | The receiver, when the payer retracts ("I haven't paid yet") | Same gates; the payment is back to `suggested`, `last_retracted_at` was stamped by the database within the last 30 minutes, and the receiver was earlier sent a paid or re-ask notice. Subject "<Payer> hasn't paid the £X yet". Once per retraction (none sent since that stamp), at most 4 per payment. The email is a courtesy: whether the next paid notice may go out depends only on `last_retracted_at`, not on this call |

All five go through the shared senders in `supabase/functions/_shared/paymentNoticeSend.ts`. Paid and confirmed are requested by the `payment-notice` edge function (called by the app after the status change, fire-and-forget); confirmed-by-email and not-received are sent by `payment-confirm` itself, only when that very call did the thing. They do not count toward the one-digest-per-person-per-day cap. The dedupe row is written before sending, so a repeated or concurrent call sends nothing. Keys: `notice:paid:<settlementId>:<receiverId>:<n>` (shared by the paid and re-ask notices, n = notices of those two kinds already recorded + 1, so normally 1, then 2 and 3 for re-asks; total capped at 4; a new paid notice after a retraction is allowed once per retraction), `notice:retracted:<settlementId>:<receiverId>:<n>`, `notice:confirmed:<settlementId>:<payerId>:1` and `notice:disputed:<settlementId>:<payerId>:<round>`. `payment-notice` events: omitted/`paid`, `confirmed`, `re_ask`, `retracted`, `disputed`; each is authorised per event (payer or manager; receiver only for `confirmed` and `disputed`) and the row's state is re-checked. Before any send, both people must have a `trip_participants` row for the payment's trip (a person who left still counts), and one person receives at most 10 notices of one kind per rolling 24 hours (counted from `notifications.sent_at`). `payment-notice` answers: **200** `{success:true}` when the thing happened, or nothing needs saying (this includes a receiver who opted out, has no address or there is no provider: a silent success, so the receiver's email settings are never revealed; also repeats); **403** not allowed / not your payment; **409** `{success:false, reason}` for refusals with `reason` one of `reask_limit`, `not_disputed`, `wrong_state`, `capped`; **429** rate limited; **502** `{success:false, reason}` when our side failed (`send_failed`, `token_failed`, `clear_failed`, `state_failed`) with nothing left half-done (a failed re-ask email restores the flag). The app tells the truth from this (`invokePaymentNotice`). The daily `unconfirmed_settlement` reminder skips a payment whose paid notice went out the same UTC day.

**Not received: no payment gets stuck.** States: `suggested` --payer marks paid--> `marked_paid` --receiver confirms--> `confirmed`. From `marked_paid` the receiver can say "not received" (flag set; stays `marked_paid`). From the flagged state: the payer asks again (flag cleared, new email/links; the receiver is back to confirm or say no; max 2 re-asks), or retracts (-> `suggested`, flag and details cleared; the payer can mark it paid again), or the receiver confirms after all (-> `confirmed`, flag cleared), or an organizer does any of these on their behalf. After two re-asks the payer is told to ask an organizer, who can still retract or confirm on the receiver's behalf, so every state has a next step for someone. Who is on the hook: while flagged, the payer has the Respond to-do, the receiver has none, the organizer sees it in Waiting on under the payer, the daily job emails nobody about it, and the Money header says "<Receiver> says £X hasn't arrived" while still counting it as sent and waiting. Database rules (guard in `20261121090000_payment_receipt_dispute.sql`, versus the previously live guard): the flag may be non-null only while `marked_paid` (CHECK, and the guard clears it on any other status, for every role); the receiver may now ALSO set it (from NULL, value replaced by `now()`, nothing else changing) and nothing else new; the payer may now ALSO retract any `marked_paid` payment of theirs (amount, currency, people, creator locked; method, note, paid date reset; flag cleared) and clear the flag ONLY via the server (`clear_receipt_dispute` runs as the payer with `auth.role() = 'service_role'`; a direct client update is refused); whenever a payment goes `marked_paid` -> `suggested` (by anyone) the guard stamps `last_retracted_at`, and any client-supplied value of that column is discarded; organizers keep full access, except that their `marked_paid` -> `suggested` now resets only the details they did not set in the same update; token functions act as the receiver for their one statement. A flagged payment still counts as sent in all the maths (so a refreeze cannot double-ask for the money); the payer's Undo is the way back, Freeze/Unfreeze are paused meanwhile, and a flag older than 3 days shows its age ("... hasn't arrived — 4 days") in the payer's Respond to-do and in organizers' Waiting on.

**Security of the confirm button.** Mail scanners and link previews open links automatically, so opening the link never changes anything.
- The token is 32 random bytes; only its SHA-256 hash is stored (`payment_confirm_tokens`), the raw token exists only in the email. It lasts 14 days and is single use. Only one live token exists per payment and receiver (a new one invalidates older unused ones). It also dies when the payment leaves `marked_paid` by any route (database trigger), and a link used after the payment was confirmed elsewhere is retired, so reverting the payment later cannot revive it.
- The page `/confirm-payment?t=<token>` moves the token out of the address bar on load (memory, plus `sessionStorage` for a refresh in the same tab, address rewritten to `/confirm-payment`) and sends no referrer. The token is only ever sent in a POST body to `payment-confirm`, never in a URL, so it is not in gateway or function request logs. `payment-confirm` answers GET with 405. Action `peek` is strictly read-only (writes only the rate-limit counter); `confirm` and `not_received` change state. The service worker caches nothing of this.
- At use the server re-checks that the payment still exists, is still `marked_paid`, has the same receiver, amount and currency as when the email was sent (also in the UPDATE itself). Anything else shows "changed". The link shows the current truth: once the payment is confirmed it says confirmed, even if the token was used to say "not received".
- The page names whose payment it is ("For <receiver>") and says "Check the money has arrived before you confirm", so a forwarded email is obvious and a reflex tap is discouraged.
- The table has row-level security with no policies, and the functions that use tokens are callable by the service role only. The `payment-confirm` function is public (the token is the credential), allows only the app's origin (not a security boundary, only a courtesy), rate limits by IP and by token, answers unknown and malformed tokens alike, and logs neither tokens nor addresses.
- The settlements guard trigger still decides everything: the database functions act as the receiver (confirm, dispute) or the payer (clear the flag) for that one statement, so the trigger's normal rules apply. The guard was extended by `20261121090000_payment_receipt_dispute.sql` only to allow the receiver to set `receipt_disputed_at`, the payer to retract (and to clear the flag via the service role only), and to stamp `last_retracted_at`.
- "I haven't received it" marks the token used, stamps `receipt_disputed_at` and leaves the payment `marked_paid`; the payer is emailed (`payment_disputed_notice`) and an activity row `settlement_receipt_disputed` is written with the receiver as actor. Settle up shows the "<Receiver> says they haven't received this" line from the column (before the migration is applied, from that activity row, only when its actor is the receiver), and a "Receipt request emailed" line only when its actor is the payer or someone who can manage the trip (anyone on the trip can insert activity rows with no actor, so other rows are ignored). Re-asks used are counted from `settlement_re_asked` rows written by the payer or a manager. The page and the app work before the migration is applied: with no `receipt_disputed_at` column the dispute actions are hidden and behaviour is as before.
- Email provider: keep click tracking OFF for these emails (the link contains the secret token; a tracked link would route it through the provider's servers and logs).
- Separately, `20261120100000_settlement_insert_guard.sql` stops an ordinary participant from creating a `confirmed` payment or one between two other people: they may insert only a `suggested` or `marked_paid` row from themselves, between two people on the trip.
