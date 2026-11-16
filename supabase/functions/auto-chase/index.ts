// Auto-Chase Engine Edge Function (NEW, plan §14). Cron-invoked (like
// refresh-fx-rates), runs with the SERVICE ROLE (this is one of the plan-
// sanctioned service-role surfaces: scanning open loops across trips and
// writing the notifications log -- it never writes trip data).
//
// Scans every open commitment loop and emails each laggard a deep link to
// their exact action:
//   - unclaimed items on expenses w/ participant_ids past the trip's
//     chase threshold;
//   - polls approaching vote_deadline with missing votes (group-vote
//     sections -> 'unvoted_poll', checked via option_votes), and personal-
//     picks order forms nearing the same deadline with participants who
//     haven't filled anything in yet (decision_shape 'personal' sections
//     -> 'unfilled_order', checked via `selections` rows instead --
//     option_votes never exist for these sections, see UX_REDESIGN.md
//     Part 5 / decisionShapes.ts);
//   - pending RSVPs near the confirmation deadline;
//   - stated-date conditionals: conditional_date arrived;
//   - waitlist lifecycle: freed spots -> claim offer to first in line
//     (feature-detected -- skipped if trip_participants.waitlist_offer_
//     expires_at doesn't exist yet, it ships in a later feature migration);
//   - settlements 'suggested'/'marked_paid' older than N days.
//
// Action-deadline reminders (Task D, staged ladder -- section 1b below):
// open trip_actions earn per-user reminders at three stages -- ~7 days
// before the effective due date ('action_due_7d'), ~1 day before
// ('action_due_1d'), and once overdue ('overdue_action') -- each fired at
// most ONCE per (action, user, stage), tracked in trip_action_reminders.
// Unlike the opt-in chase kinds above these run for EVERY trip by default:
// creating an action with a deadline is itself the opt-in. Gated by
// chase_settings.action_reminders (opt-OUT, defaults to true -- see
// ./chaseSettings.ts) and quiet hours, but NOT by chase_settings.enabled.
// Targeting: assigned_to if set (skip if completed via
// trip_action_completions), else every active participant without a
// completion row. Effective due date is due_date for 'fixed' deadline_kind,
// trip.start_date for 'before_trip' (skipped when start_date is null). Date
// math lives in ./actionDueDate.ts so it's unit-testable without the
// service client.
//
// T-minus date-intelligence kinds (UX_REDESIGN.md Part 3 "T-minus nudges
// feed the existing chaser"), all respecting the same chase_settings
// opt-in/quiet-hours/cap machinery as every other kind above:
//   - t30_no_transport: T-30 (start_date within 30 days, still >0 days
//     out), no booking/plan item categorized as flight/transport exists
//     yet -> ORGANIZER-only nudge (once; this is a trip-wide gap, not a
//     per-person one);
//   - t14_missing_arrival: T-14, per PARTICIPANT who has no "travel
//     details" timeline event (category flight/transfer) tagged to them
//     (participant_ids null = everyone, so an untargeted arrival event
//     covers everyone);
//   - t1_checkin: T-1, flight bookings that have a confirmation_ref (i.e.
//     something to check in for) -> nudge the person who made the booking
//     (booked_by) to check in.
//
// Anti-chaos caps (plan §14): max 1 chase email per person per day (items
// bundle into one digest), max 3 reminders per item then escalate to the
// blockers board ("needs a personal nudge"), per-user opt-out
// (users.email_notifications_enabled), per-trip opt-IN + settings
// (trips.chase_settings jsonb: {enabled, action_reminders, delay_hours,
// quiet_hours:{start, end}, max_reminders} -- see ./chaseSettings.ts for the
// two independent enabled/action_reminders defaults). Every send logged to
// notifications; dedupe_key (kind:entity:user:seq) enforces the caps at the
// DB level.
//
// Email channel: Resend if RESEND_API_KEY is set, Brevo if BREVO_API_KEY;
// otherwise sends are skipped, logged with channel='skipped', and returned
// as WhatsApp-ready chase_drafts for the blockers board (plan: degrade
// gracefully). All emails render through the shared "Tim's Trip Planner"
// template in _shared/emailTemplate.ts -- one digest per user per day.
//
// Phase 1 (slice 1F) -- one definition of "what does this person owe":
//   - every email link is the exact deep link for the thing it is about
//     (`?open=question:<id>`, `rsvp`, `todo:<id>`, `payment:<id>`,
//     `travel-details`, `claim:<expenseId>` or the /claim/:code page), built
//     from the mirrored DEEP_LINKS (_shared/todos/copy.ts); each trip section
//     of the digest ends with "See all your to-dos" -> `?open=todos`;
//   - the shared engine (_shared/todos, mirror of src/lib/todos) FILTERS the
//     candidates (see ./chaseEngine.ts): selections count as answered, no
//     email for questions without live options, RSVP chases need RSVP
//     tracking on, travel chases only for confirmed people before the trip.
//     It can only remove recipients, never add them: no new email kinds, no
//     email for questions without a deadline. Dedupe keys are unchanged.
//
// Phase 4D -- what moves by itself (all fail-soft, all before the sweeps):
//   - stage sync: stored trips.status moves FORWARD to trip_ongoing /
//     trip_completed when the trip's dates say so (./autoDecide.ts stageSyncTarget);
//   - auto-decide: open Group-choice questions whose deadline passed within
//     the last 48h are decided through the service-role-only SQL function
//     auto_decide_question (clear leader only; ties become an organizer to-do,
//     which the to-dos engine derives -- no email); trips.chase_settings.
//     auto_decide=false opts a trip out;
//   - "We have an answer": the ONE new email kind ('decision'), once per
//     decided question per asked person, folded into the daily digest.
//     See section j in the trip loop.
//
// Test entrypoint: POST {"test_digest": {"trip_id", "user_id", "to_email"}}
// (same cron/service-role auth) composes that user's action digest for one
// trip and sends it to to_email ONLY -- no notification/reminder state is
// written, so a test can never fan out or consume a real reminder stage.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, jsonResponse, UnauthorizedError } from '../_shared/errors.ts'
import { serviceClient } from '../_shared/supabaseClients.ts'
import { type EmailSender, getEmailSender } from '../_shared/emailSender.ts'
import { type DigestActionRow, type DigestTripSection, renderDigestEmail, type StatusChipTone } from '../_shared/emailTemplate.ts'
import {
  actionDueChipLabel,
  actionReminderStage,
  type ActionReminderStage,
  effectiveActionDueDate,
} from './actionDueDate.ts'
import {
  buildSectionVoters,
  type OptionForSectionVoters,
  type SectionVoterIds,
  type VoteForSectionVoters,
} from '../_shared/actionCompletion/sectionVoters.ts'
import { outstandingTargets } from './outstandingTargets.ts'
import { chaseScopes, isChaseableParticipant, isSectionClosed, isTripOpenForReminders, joinedAfterDueDate } from './chaseScope.ts'
import { actionRemindersGateOpen, DEFAULT_SETTINGS, inQuietHours, parseChaseSettings } from './chaseSettings.ts'
import {
  autoDecideDeadlineBounds,
  type AutoDecideSectionRow,
  type AutoDecideSummary,
  buildDecisionAnnouncement,
  type DecidedSectionRow,
  decisionAnnounceSince,
  decisionDedupeKey,
  DECISION_KIND,
  decisionRecipients,
  isAutoDecideCandidate,
  lastHumanStatusChange,
  recentDecisionsFromActivity,
  runAutoDecide,
  stageSyncTarget,
} from './autoDecide.ts'
import { decideEmailSuppression } from './emailSuppression.ts'
import { type AnswerPass } from '../_shared/answers/answers.ts'
import type { Json } from '../_shared/todos/deps/json.ts'
import {
  addPassesToSectionVoters,
  answerTodoId,
  type ChaseSectionRow,
  claimChaseOpen,
  claimEmailLink,
  DEEP_LINKS,
  emailLink,
  engineTodoIds,
  isOwnChoiceSection,
  rsvpTodoId,
  toEngineSections,
  travelTodoId,
} from './chaseEngine.ts'
import {
  answerDescription,
  claimDescription,
  conditionalDateDescription,
  confirmPaymentDescription,
  payDescription,
  rsvpDescription,
  travelDescription,
  waitlistOfferDescription,
} from './chaseCopy.ts'

import { PAID_NOTICE_KIND, REASK_NOTICE_KIND, paidNoticeSentToday, type PaidNoticeRow } from './paymentNoticeToday.ts'
import { settlementChase } from './settlementChase.ts'
import type { ChaseKind } from './chaseKinds.ts'

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'https://trips.fontem.ai'

/** One open loop targeting one user. */
interface ChaseItem {
  tripId: string
  tripName: string
  userId: string
  kind: ChaseKind
  entityType: string
  entityId: string
  /** Overrides the default `chase:<kind>:<entityId>:<userId>:<seq>` dedupe key (the decision email carries the winner in it). */
  dedupeKey?: string
  description: string
  deepLink: string
  /** Present on 'decision' items ("We have an answer", Phase 4D): rendered in the digest's own block. */
  decision?: { headline: string; details: string[] }
  /** Present on staged action-deadline reminders (section 1b): drives the
   * digest's actions table + the once-per-stage sent-state marking. */
  actionReminder?: {
    actionId: string
    stage: ActionReminderStage
    title: string
    deadlineLabel: string
    chipLabel: string
    chipTone: StatusChipTone
  }
}

/** "Fri 1 Aug" (UTC calendar date); before_trip deadlines say so explicitly. */
function formatDueDate(dueDateStr: string, deadlineKind: 'fixed' | 'before_trip'): string {
  const label = new Date(dueDateStr + 'T00:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
  return deadlineKind === 'before_trip' ? `Trip start (${label})` : label
}

function stageChipTone(stage: ActionReminderStage | null): StatusChipTone {
  if (stage === 'overdue') return 'overdue'
  if (stage === 'd1') return 'due-soon'
  return 'upcoming'
}

function stageKind(stage: ActionReminderStage): 'action_due_7d' | 'action_due_1d' | 'overdue_action' {
  if (stage === 'overdue') return 'overdue_action'
  return stage === 'd1' ? 'action_due_1d' : 'action_due_7d'
}

/** hoursAgo helper: ISO string for now - h hours. */
function hoursAgoIso(h: number, now: Date): string {
  return new Date(now.getTime() - h * 3600_000).toISOString()
}

function hoursAheadIso(h: number, now: Date): string {
  return new Date(now.getTime() + h * 3600_000).toISOString()
}

/** Feature-detect trip_participants.waitlist_offer_expires_at (plan: skip if absent). */
async function waitlistColumnExists(admin: SupabaseClient): Promise<boolean> {
  const { error } = await admin
    .from('trip_participants')
    .select('waitlist_offer_expires_at')
    .limit(1)
  return !error
}

/** Shape of an `options` row selected with its embedded `option_votes`. */
interface SectionOptionRow {
  id: string
  section_id: string
  option_votes: { user_id: string }[] | null
  selections: { user_id: string }[] | null
}

/**
 * DERIVED completion substrate (see src/features/actions/lib/actionStatus.ts
 * and _shared/actionCompletion/sectionVoters.ts): fetch every option +
 * option_votes / selections row under `sectionIds` and join them into a SectionVoterIds
 * map, so `outstandingTargets` can tell a section-linked action is complete
 * for anyone who's voted, even without a trip_action_completions row.
 * Shared by the staged-reminder sweep and the test-digest entrypoint below.
 */
async function fetchSectionVoters(admin: SupabaseClient, sectionIds: string[]): Promise<SectionVoterIds> {
  if (sectionIds.length === 0) return new Map()
  const { data } = await admin
    .from('options')
    .select('id, section_id, option_votes(user_id), selections(user_id)')
    .in('section_id', sectionIds)
  const rows = (data ?? []) as SectionOptionRow[]
  const options: OptionForSectionVoters[] = rows.map((o) => ({ id: o.id, section_id: o.section_id }))
  // A selection row (own-choice answers, grid answers) is an answer exactly
  // like a vote: it has option_id + user_id, same as src/lib/answers/answers.ts.
  const votes: VoteForSectionVoters[] = rows.flatMap((o) =>
    [...(o.option_votes ?? []), ...(o.selections ?? [])].map((v) => ({ option_id: o.id, user_id: v.user_id }))
  )
  const voters = buildSectionVoters(options, votes)
  // A pass ("No preference" / "None for me") is an answer too. Fail-soft.
  const passes = await fetchQuestionPasses(admin, sectionIds)
  if (passes.length === 0) return voters
  const { data: secs } = await admin.from('planning_sections').select('id, metadata').in('id', sectionIds)
  const metadata = new Map<string, Json | null>(
    ((secs ?? []) as { id: string; metadata: Json | null }[]).map((r) => [r.id, r.metadata])
  )
  return addPassesToSectionVoters(voters, passes, metadata)
}

/**
 * `question_passes` rows for `sectionIds`. Fail-soft: until the migration is
 * applied the table does not exist; any error means "no passes" (logged as a
 * warning at most), so the emails behave exactly as before passes existed.
 * Passes only ever remove recipients.
 */
async function fetchQuestionPasses(admin: SupabaseClient, sectionIds: string[]): Promise<AnswerPass[]> {
  if (sectionIds.length === 0) return []
  try {
    const { data, error } = await admin
      .from('question_passes')
      .select('section_id, user_id, kind')
      .in('section_id', sectionIds)
    if (error) {
      console.warn('auto-chase: question_passes unavailable, treating as none:', error.message)
      return []
    }
    return (data ?? []) as AnswerPass[]
  } catch (e) {
    console.warn('auto-chase: question_passes fetch failed, treating as none:', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Ids (among `actionIds`) of Anyone to-dos nobody has claimed yet. An unclaimed
 * Anyone item is nobody's to-do, so it never earns a reminder (and this can only
 * remove recipients, never add any). Fail-soft: until the who_mode migration is
 * applied the column does not exist, the query errors and nothing is skipped.
 */
async function fetchUnclaimedAnyoneActionIds(admin: SupabaseClient, actionIds: string[]): Promise<Set<string>> {
  if (actionIds.length === 0) return new Set()
  try {
    const { data, error } = await admin
      .from('trip_actions')
      .select('id')
      .in('id', actionIds)
      .eq('who_mode', 'anyone')
      .is('assigned_to', null)
    if (error) return new Set()
    return new Set((data ?? []).map((r: { id: string }) => r.id))
  } catch {
    return new Set()
  }
}

/** Ids among `sectionIds` whose planning_sections.status is 'completed' (closed). */
async function fetchClosedSectionIds(admin: SupabaseClient, sectionIds: string[]): Promise<Set<string>> {
  if (sectionIds.length === 0) return new Set()
  const { data } = await admin.from('planning_sections').select('id, status').in('id', sectionIds)
  return new Set((data ?? []).filter((s) => isSectionClosed(s)).map((s) => s.id as string))
}

/**
 * Stage sync (Phase 4D): when a trip's DATES say it has started or finished but
 * the stored trips.status lags, move the stored status FORWARD to match. Rule
 * (stageSyncTarget): dates must be present and sane, never backwards, never a
 * finished trip. Compare-and-set on the old status so a concurrent organizer
 * edit always wins. Logs a status_changed activity row (auto, no actor).
 * Fail-soft: never throws.
 */
async function syncTripStages(admin: SupabaseClient, now: Date): Promise<Array<{ trip_id: string; from: string; to: string }>> {
  const moved: Array<{ trip_id: string; from: string; to: string }> = []
  try {
    const { data, error } = await admin
      .from('trips')
      .select('id, status, start_date, end_date')
      .neq('status', 'trip_completed')
      .not('start_date', 'is', null)
      .not('end_date', 'is', null)
    if (error) {
      console.warn('[auto-chase] stage sync: trips query failed, skipping:', error.message)
      return moved
    }
    const today = now.toISOString().slice(0, 10)
    for (const t of (data ?? []) as Array<{ id: string; status: string; start_date: string; end_date: string }>) {
      try {
        if (!stageSyncTarget(t, today)) continue // cheap pre-check before the activity lookup
        const { data: changes } = await admin
          .from('activity_feed')
          .select('actor, created_at, metadata')
          .eq('trip_id', t.id)
          .eq('verb', 'status_changed')
        const target = stageSyncTarget(t, today, lastHumanStatusChange((changes ?? []) as Parameters<typeof lastHumanStatusChange>[0]))
        if (!target) continue
        const { data: updated, error: updError } = await admin
          .from('trips')
          .update({ status: target })
          .eq('id', t.id)
          .eq('status', t.status)
          .select('id')
        if (updError) {
          console.warn('[auto-chase] stage sync: update failed for trip', t.id, updError.message)
          continue
        }
        if (!updated || updated.length === 0) continue // changed under us: leave it
        moved.push({ trip_id: t.id, from: t.status, to: target })
        const { error: actError } = await admin.from('activity_feed').insert({
          trip_id: t.id,
          actor: null,
          verb: 'status_changed',
          entity: { type: 'trip', id: t.id, label: target },
          metadata: { from: t.status, to: target, source: 'dates', auto: true },
        })
        if (actError) console.warn('[auto-chase] stage sync: activity log failed for trip', t.id, actError.message)
      } catch (e) {
        console.warn('[auto-chase] stage sync failed for trip, continuing:', t.id, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.warn('[auto-chase] stage sync failed, continuing:', e instanceof Error ? e.message : e)
  }
  return moved
}

/**
 * Auto-decide pass (Phase 4D): for every open question whose answer-by
 * deadline passed within the last 48 hours (AUTO_DECIDE_WINDOW_HOURS), on
 * trips that are not finished and have not switched auto_decide off, ask the
 * database to decide it (auto_decide_question: clear leader only; ties, no
 * answers, Own choice, date polls are refused there). Per-trip isolation;
 * FAIL-SOFT when the function is not installed yet. The "We have an answer"
 * email is NOT sent from here: the announcement step in the main loop finds
 * the poll_closed activity row this call writes, same as for organizer decisions.
 */
async function autoDecidePass(admin: SupabaseClient, now: Date): Promise<AutoDecideSummary & { candidates: number }> {
  const total: AutoDecideSummary & { candidates: number } = {
    candidates: 0, attempted: 0, decided: 0, tied: 0, skipped: 0, errors: 0, rpcMissing: false,
  }
  try {
    const { from, to } = autoDecideDeadlineBounds(now)
    const { data, error } = await admin
      .from('planning_sections')
      .select('id, title, status, vote_deadline, metadata, trip_id, trips!inner(status, end_date, chase_settings)')
      .neq('status', 'completed')
      .gte('vote_deadline', from)
      .lte('vote_deadline', to)
    if (error) {
      console.warn('[auto-chase] auto-decide: candidate query failed, skipping:', error.message)
      return total
    }
    const byTrip = new Map<string, string[]>()
    for (const row of (data ?? []) as unknown as Array<AutoDecideSectionRow & { trip_id: string; trips: unknown }>) {
      const tripRow = (Array.isArray(row.trips) ? row.trips[0] : row.trips) as { status?: string | null; end_date?: string | null; chase_settings?: unknown } | undefined
      if (!tripRow || !isAutoDecideCandidate(row, tripRow, now)) continue
      const list = byTrip.get(row.trip_id) ?? []
      list.push(row.id)
      byTrip.set(row.trip_id, list)
      total.candidates++
    }
    for (const [tripId, ids] of byTrip) {
      try {
        const r = await runAutoDecide({ rpc: (fn, args) => admin.rpc(fn, args) }, ids)
        total.attempted += r.attempted
        total.decided += r.decided
        total.tied += r.tied
        total.skipped += r.skipped
        total.errors += r.errors
        if (r.rpcMissing) {
          total.rpcMissing = true
          break // not installed yet: no point asking again for other trips
        }
      } catch (e) {
        total.errors++
        console.warn('[auto-chase] auto-decide failed for trip, continuing:', tripId, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.warn('[auto-chase] auto-decide pass failed, continuing:', e instanceof Error ? e.message : e)
  }
  return total
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    // Cron/service-role only -- no ordinary user may trigger a sweep. Two
    // accepted credentials (the platform's verify_jwt already rejects
    // unsigned calls before we get here):
    //  - the service-role key as the bearer token (manual ops), OR
    //  - an x-cron-secret header matching app_secrets.'auto_chase_cron_secret'.
    //    The pg_cron job sends the anon key as its bearer (satisfies
    //    verify_jwt; storing the service-role key in the job body was ruled
    //    out in 20260718150500_cron_fx_rates_auth_header.sql) plus this
    //    secret, which it reads from app_secrets at fire time. The secret is
    //    generated by gen_random_bytes() inside the migration that schedules
    //    the job, so it lives only in the database -- never in the repo --
    //    and app_secrets is RLS-locked with anon/authenticated revoked.
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const isServiceRole = !!token && token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    const admin = serviceClient()

    if (!isServiceRole) {
      const cronSecret = req.headers.get('x-cron-secret')
      let cronOk = false
      if (cronSecret) {
        const { data: secretRow } = await admin
          .from('app_secrets')
          .select('value')
          .eq('name', 'auto_chase_cron_secret')
          .maybeSingle()
        cronOk = !!secretRow?.value && secretRow.value === cronSecret
      }
      if (!cronOk) throw new UnauthorizedError('auto-chase is cron/service-role only')
    }

    const emailSender = getEmailSender()
    const now = new Date()

    // Test entrypoint (see header comment): single-recipient, zero writes.
    let body: Record<string, unknown> = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    if (body && typeof body === 'object' && body.test_digest) {
      return await handleTestDigest(
        admin,
        emailSender,
        now,
        body.test_digest as { trip_id?: string; user_id?: string; to_email?: string }
      )
    }
    const todayStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()

    const hasWaitlistColumn = await waitlistColumnExists(admin)

    // ---- 0. What moves by itself (Phase 4D). Both passes are fail-soft and
    // run BEFORE the reminder sweeps so the sweeps see fresh trip statuses
    // and the "We have an answer" announcements see this run's decisions. ----
    const stagesMoved = await syncTripStages(admin, now)
    const autoDecide = await autoDecidePass(admin, now)

    // ---- 1. Load chase-enabled trips (opt-in via trips.chase_settings.enabled) ----
    const { data: trips, error: tripsError } = await admin
      .from('trips')
      .select(
        'id, name, status, capacity_limit, confirmation_deadline, confirmation_enabled, base_currency, chase_settings, start_date, end_date, settlement_snapshot'
      )
      .not('chase_settings', 'is', null)
    if (tripsError) throw tripsError

    const chaseTrips = (trips ?? [])
      .map((t) => ({ ...t, settings: parseChaseSettings(t.chase_settings) }))
      .filter((t) => t.settings.enabled && !inQuietHours(t.settings, now))

    const items: ChaseItem[] = []
    const waitlistOffersSent: Array<{ trip_id: string; user_id: string; expires_at: string }> = []

    for (const trip of chaseTrips) {
      // One bad trip row must never stop everyone else's reminders. Anything
      // already pushed to `items` for this trip is still valid and is sent
      // (and deduped per item by `notifications.dedupe_key` as always), so a
      // retry cannot double-send; the rest of this trip waits for tomorrow.
      try {
      const tripLink = emailLink(APP_BASE_URL, trip.id)
      // Finished trips (completed, or end date passed) get no more
      // planning-phase chases (votes, picks, RSVP, arrival details). Money
      // reminders -- unclaimed items (a) and settlements (f) -- are NOT
      // gated on this: settling up happens exactly after the trip ends.
      const { planning: tripOpen, money: moneyOpen } = chaseScopes(trip, now)

      // Active participants (used by several loops below).
      const { data: participants } = await admin
        .from('trip_participants')
        .select('user_id, role, active, confirmation_status, conditional_type, conditional_date, created_at')
        .eq('trip_id', trip.id)
        .eq('active', true)
      const activeParticipants = participants ?? []
      // Declined/cancelled people are out of scope for every chase that asks
      // them to DO something (vote, pick, claim, add arrival details).
      // RSVP / waitlist / conditional kinds below still read
      // `activeParticipants` since those statuses are exactly their trigger.
      const chaseableParticipants = activeParticipants.filter(isChaseableParticipant)
      const participantIds = chaseableParticipants.map((p) => p.user_id)
      // Money reminders (a) keep their pre-existing audience: every active
      // participant, exactly as before the scope changes.
      const allActiveIds = activeParticipants.map((p) => p.user_id)

      // ---- a. Unclaimed items on itemized expenses past threshold ----
      // Not once balances are frozen: claims are locked, so the link would be a dead end.
      if (moneyOpen && claimChaseOpen(trip.settlement_snapshot)) {
        const { data: expenses } = await admin
          .from('expenses')
          .select('id, description, amount, currency, paid_by, participant_ids, created_at, expense_item_claims(user_id), expense_allocation_links(code)')
          .eq('trip_id', trip.id)
          .eq('ai_parsed', true)
          .in('status', ['unallocated', 'pending_allocation'])
          .lt('created_at', hoursAgoIso(trip.settings.delay_hours, now))
        for (const e of expenses ?? []) {
          // Chase only tagged people when participant_ids is set (plan §14
          // "itemized receipts chase only tagged people"), else everyone.
          const targets: string[] = (e.participant_ids && e.participant_ids.length > 0 ? e.participant_ids : allActiveIds)
            .filter((uid: string) => uid !== e.paid_by)
          // deno-lint-ignore no-explicit-any
          const claimedBy = new Set((e.expense_item_claims ?? []).map((c: any) => c.user_id))
          // deno-lint-ignore no-explicit-any
          const claimCode = (e.expense_allocation_links ?? [])[0]?.code as string | undefined
          for (const uid of targets) {
            if (claimedBy.has(uid)) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: uid,
              kind: 'unclaimed_items',
              entityType: 'expense',
              entityId: e.id,
              description: claimDescription(e.description, e.amount, e.currency),
              // The /claim/:code page keeps working for people without the app open.
              // Without a code there is nothing to claim on, so go to the money tab
              // rather than a dead "Claiming isn't open" page.
              deepLink: claimEmailLink(APP_BASE_URL, trip.id, claimCode),
            })
          }
        }
      }

      // ---- b. Sections approaching their deadline with participants who
      // haven't responded: group-vote polls checked via option_votes
      // ('unvoted_poll'), personal-picks order forms checked via
      // `selections` instead ('unfilled_order' -- decision_shape 'personal'
      // sections never get option_votes rows at all, so reusing the vote
      // check here would nag everyone forever with the wrong "vote"
      // wording; see UX_REDESIGN.md Part 5 / decisionShapes.ts's
      // getDecisionShape convention: metadata.decision_shape, absent = 'vote'). ----
      if (tripOpen) {
        const { data: sections } = await admin
          .from('planning_sections')
          .select('id, title, status, vote_deadline, voting_method, metadata, options(id, status, option_votes(user_id), selections(user_id))')
          .eq('trip_id', trip.id)
          .neq('status', 'completed') // closed polls / finished decisions are never chased
          .not('vote_deadline', 'is', null)
          .gt('vote_deadline', now.toISOString())
          .lt('vote_deadline', hoursAheadIso(48, now))
        // The shared engine decides who still owes an answer (votes AND
        // selections, a question with live options, an in-scope person).
        const sectionRows = (sections ?? []) as unknown as ChaseSectionRow[]
        const { sections: engineSections, votes: engineVotes } = toEngineSections(sectionRows)
        const enginePasses = await fetchQuestionPasses(admin, sectionRows.map((r) => r.id))
        const owed = engineTodoIds(
          { trip, participants: activeParticipants, sections: engineSections, votes: engineVotes, passes: enginePasses },
          participantIds,
          now
        )
        for (const s of sectionRows) {
          if (isSectionClosed(s)) continue // belt and braces for the .neq above
          // Own choice (decision_shape 'personal') keeps its own kind so the
          // dedupe keys and reminder counts are exactly what they were.
          const isPersonal = isOwnChoiceSection(s.metadata)
          const deadlineIso = s.vote_deadline as string
          for (const uid of participantIds) {
            if (!owed.get(uid)?.has(answerTodoId(s.id))) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: uid,
              kind: isPersonal ? 'unfilled_order' : 'unvoted_poll',
              entityType: 'planning_section',
              entityId: s.id,
              description: answerDescription(s.title, isPersonal, deadlineIso),
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.question(s.id)),
            })
          }
        }
      }

      // ---- c. Pending RSVPs near the confirmation deadline ----
      if (tripOpen && trip.confirmation_deadline) {
        const deadline = new Date(trip.confirmation_deadline)
        const within72h = deadline.getTime() - now.getTime() < 72 * 3600_000 && deadline.getTime() > now.getTime()
        if (within72h) {
          // "Are you coming?" is a to-do only while RSVP tracking is on, and
          // 'interested' people only because a reply-by deadline exists (the
          // outer condition). The engine confirms both.
          const rsvpOwed = engineTodoIds({ trip, participants: activeParticipants }, activeParticipants.map((p) => p.user_id), now)
          for (const p of activeParticipants) {
            if (p.confirmation_status === 'pending' || p.confirmation_status === 'interested') {
              if (!rsvpOwed.get(p.user_id)?.has(rsvpTodoId(trip.id))) continue
              items.push({
                tripId: trip.id,
                tripName: trip.name,
                userId: p.user_id,
                kind: 'pending_rsvp',
                entityType: 'trip_participant',
                entityId: trip.id,
                description: rsvpDescription(trip.name, trip.confirmation_deadline),
                deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.rsvp()),
              })
            }
          }
        }
      }

      // ---- d. Stated-date conditionals: conditional_date arrived ----
      if (tripOpen) {
        const todayStr = now.toISOString().split('T')[0]
        const conditionalOwed = engineTodoIds({ trip, participants: activeParticipants }, activeParticipants.map((p) => p.user_id), now)
        for (const p of activeParticipants) {
          if (!conditionalOwed.get(p.user_id)?.has(rsvpTodoId(trip.id))) continue
          if (
            p.confirmation_status === 'conditional' &&
            (p.conditional_type === 'date' || p.conditional_type === 'both') &&
            p.conditional_date &&
            p.conditional_date <= todayStr
          ) {
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: p.user_id,
              kind: 'conditional_date_arrived',
              entityType: 'trip_participant',
              entityId: trip.id,
              description: conditionalDateDescription(trip.name, p.conditional_date),
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.rsvp()),
            })
          }
        }
      }

      // ---- e. Waitlist lifecycle (feature-detected) ----
      if (tripOpen && hasWaitlistColumn && trip.capacity_limit) {
        const confirmedCount = activeParticipants.filter((p) => p.confirmation_status === 'confirmed').length
        const freeSpots = trip.capacity_limit - confirmedCount
        if (freeSpots > 0) {
          // Re-read with the offer column (only selectable when it exists).
          const { data: waitlisted } = await admin
            .from('trip_participants')
            .select('user_id, created_at, waitlist_offer_expires_at')
            .eq('trip_id', trip.id)
            .eq('active', true)
            .eq('confirmation_status', 'waitlist')
            .order('created_at', { ascending: true })
          // deno-lint-ignore no-explicit-any
          const queue = (waitlisted ?? []) as any[]
          // Anyone holding a live offer occupies a free spot; expired offers cascade.
          const liveOffers = queue.filter((w) => w.waitlist_offer_expires_at && w.waitlist_offer_expires_at > now.toISOString())
          let spotsToOffer = freeSpots - liveOffers.length
          for (const w of queue) {
            if (spotsToOffer <= 0) break
            const hasLiveOffer = w.waitlist_offer_expires_at && w.waitlist_offer_expires_at > now.toISOString()
            if (hasLiveOffer) continue
            const expiresAt = hoursAheadIso(48, now)
            const { error: offerError } = await admin
              .from('trip_participants')
              .update({ waitlist_offer_expires_at: expiresAt })
              .eq('trip_id', trip.id)
              .eq('user_id', w.user_id)
            if (offerError) {
              console.error('[auto-chase] waitlist offer update failed:', offerError)
              continue
            }
            waitlistOffersSent.push({ trip_id: trip.id, user_id: w.user_id, expires_at: expiresAt })
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: w.user_id,
              kind: 'waitlist_offer',
              entityType: 'trip_participant',
              entityId: trip.id,
              description: waitlistOfferDescription(trip.name, expiresAt),
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.rsvp()),
            })
            spotsToOffer--
          }
        }
      }

      // ---- f. Settlements 'suggested'/'marked_paid' older than N days ----
      if (moneyOpen) {
        const staleDays = 3
        const settlementQuery = (cols: string) =>
          admin
            .from('settlements')
            .select(cols)
            .eq('trip_id', trip.id)
            .in('status', ['suggested', 'marked_paid'])
            .lt('created_at', hoursAgoIso(staleDays * 24, now))
        // receipt_disputed_at may not exist yet (migration not applied): retry without it.
        // deno-lint-ignore no-explicit-any
        let settlementRes: { data: any[] | null; error: unknown } = await settlementQuery('id, from_user_id, to_user_id, amount, currency, status, created_at, receipt_disputed_at')
        if (settlementRes.error) settlementRes = await settlementQuery('id, from_user_id, to_user_id, amount, currency, status, created_at')
        const settlements = settlementRes.data
        const nameIds = [...new Set((settlements ?? []).flatMap((s) => [s.from_user_id as string, s.to_user_id as string]))]
        const nameById = new Map<string, string>()
        if (nameIds.length > 0) {
          const { data: nameRows } = await admin.from('users').select('id, first_name, full_name').in('id', nameIds)
          for (const u of nameRows ?? []) {
            const first = (u.first_name as string | null)?.trim() || (u.full_name as string | null)?.trim().split(/\s+/)[0]
            if (first) nameById.set(u.id as string, first)
          }
        }
        // Payments whose "X paid you" notice already went out today (payment-notice function): not nudged again the same day.
        const markedPaidIds = (settlements ?? []).filter((s) => s.status === 'marked_paid').map((s) => s.id as string)
        let paidNoticesToday: PaidNoticeRow[] = []
        if (markedPaidIds.length > 0) {
          const { data: noticeRows } = await admin
            .from('notifications')
            .select('entity_id, user_id, sent_at')
            .in('kind', [PAID_NOTICE_KIND, REASK_NOTICE_KIND])
            .in('entity_id', markedPaidIds)
            .gte('sent_at', todayStartIso)
          paidNoticesToday = (noticeRows ?? []) as PaidNoticeRow[]
        }
        for (const s of settlements ?? []) {
          const chase = settlementChase(s)
          if (!chase) continue // confirmed, or the receiver already said "it hasn't arrived": nobody is chased
          if (chase.kind === 'unpaid_settlement') {
            // Chase the payer to pay.
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: chase.userId,
              kind: 'unpaid_settlement',
              entityType: 'settlement',
              entityId: s.id,
              description: payDescription(trip.name, s.amount, s.currency ?? trip.base_currency, nameById.get(s.to_user_id)),
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.payment(s.id)),
            })
          } else {
            // marked_paid: chase the recipient to confirm receipt (unless they were emailed about it today).
            if (paidNoticeSentToday(paidNoticesToday, s.id, s.to_user_id, todayStartIso)) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: chase.userId,
              kind: 'unconfirmed_settlement',
              entityType: 'settlement',
              entityId: s.id,
              description: confirmPaymentDescription(trip.name, s.amount, s.currency ?? trip.base_currency, nameById.get(s.from_user_id)),
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.payment(s.id)),
            })
          }
        }
      }

      // (Action-deadline reminders moved to section 1b below -- they run
      // for ALL trips, not just chase-enabled ones, on a staged
      // once-per-stage ladder instead of this loop's daily re-nag.)

      // ---- Date-intelligence T-minus kinds (UX_REDESIGN.md Part 3) ----
      // Shared "days until start" for the trip, used by both t30 and t14.
      const daysUntilStart = trip.start_date
        ? Math.floor((new Date(trip.start_date + 'T00:00:00Z').getTime() - now.getTime()) / 86_400_000)
        : null

      // ---- g. t30_no_transport: T-30, no flight/transport booking or plan
      // item exists yet -> organizer-only nudge (a trip-wide gap, not a
      // per-person one; a single flight/transport item covers everyone). ----
      if (tripOpen && daysUntilStart != null && daysUntilStart <= 30 && daysUntilStart >= 0) {
        const { data: transportEvents } = await admin
          .from('trip_timeline_events')
          .select('id')
          .eq('trip_id', trip.id)
          .in('category', ['flight', 'transport'])
          .limit(1)
        let hasTransport = (transportEvents ?? []).length > 0
        if (!hasTransport) {
          // Bookings carry no category of their own -- check via their
          // linked option's section_type (accommodation/flights/transport/...).
          const { data: transportBookings } = await admin
            .from('bookings')
            .select('id, option_id, options(section_type)')
            .eq('trip_id', trip.id)
          // deno-lint-ignore no-explicit-any
          hasTransport = (transportBookings ?? []).some((b: any) => b.options?.section_type === 'flights' || b.options?.section_type === 'transport')
        }
        if (!hasTransport) {
          const organizers = activeParticipants.filter((p) => p.role === 'organizer')
          for (const organizer of organizers) {
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: organizer.user_id,
              kind: 't30_no_transport',
              entityType: 'trip',
              entityId: trip.id,
              description: `"${trip.name}" starts in ${daysUntilStart} days and nobody's booked flights or transport yet -- worth chasing?`,
              deepLink: tripLink,
            })
          }
        }
      }

      // ---- h. t14_missing_arrival: T-14, per participant with no travel-
      // details event (category flight/transfer) tagged to them. An event
      // with participant_ids = null covers everyone. ----
      if (tripOpen && daysUntilStart != null && daysUntilStart <= 14 && daysUntilStart >= 0) {
        const { data: travelEvents } = await admin
          .from('trip_timeline_events')
          .select('title, participant_ids, metadata')
          .eq('trip_id', trip.id)
          .in('category', ['flight', 'transfer'])
        const events = travelEvents ?? []
        const everyoneCovered = events.some((e) => e.participant_ids === null)
        if (!everyoneCovered) {
          const coveredIds = new Set(events.flatMap((e) => e.participant_ids ?? []))
          // The engine adds: confirmed people only (when RSVP tracking is on)
          // and only until the trip starts.
          const travelOwed = engineTodoIds({ trip, participants: activeParticipants, travelEvents: events }, participantIds, now)
          for (const p of chaseableParticipants) {
            if (coveredIds.has(p.user_id)) continue
            if (!travelOwed.get(p.user_id)?.has(travelTodoId(trip.id))) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: p.user_id,
              kind: 't14_missing_arrival',
              entityType: 'trip_participant',
              entityId: trip.id,
              description: travelDescription(trip.name),
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.travelDetails()),
            })
          }
        }
      }

      // ---- i. t1_checkin: T-1, flight bookings with a confirmation_ref
      // (something to actually check in for) -> nudge whoever booked it. ----
      if (tripOpen && daysUntilStart === 1) {
        const { data: flightBookings } = await admin
          .from('bookings')
          .select('id, title, booked_by, confirmation_ref, option_id, options(section_type)')
          .eq('trip_id', trip.id)
          .not('confirmation_ref', 'is', null)
          .neq('status', 'cancelled')
        // deno-lint-ignore no-explicit-any
        for (const b of (flightBookings ?? []) as any[]) {
          const looksLikeFlight = b.options?.section_type === 'flights' || /flight|airline|airways/i.test(b.title ?? '')
          if (!looksLikeFlight) continue
          items.push({
            tripId: trip.id,
            tripName: trip.name,
            userId: b.booked_by,
            kind: 't1_checkin',
            entityType: 'booking',
            entityId: b.id,
            description: `Check in for "${b.title}" (ref ${b.confirmation_ref}) -- it's tomorrow!`,
            // The decided option's plan item when the booking has one.
            deepLink: b.option_id ? emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.item(b.option_id)) : tripLink,
          })
        }
      }

      // ---- j. "We have an answer" (Phase 4D): ONE email kind, once per
      // decided question per person. Recipients = the people who were asked
      // (active, not declined/cancelled), minus whoever made the decision.
      // Found via the poll_closed activity row (organizer decisions and
      // auto-decisions both log it) inside DECISION_ANNOUNCE_WINDOW_HOURS, so
      // old decisions are never announced retroactively. Deduped forever by
      // chase:decision:<sectionId>:<optionId>:<userId>:1, folded into the user's digest
      // below (never a second email on the same day). ----
      if (tripOpen && participantIds.length > 0) {
        try {
          const { data: activityRows } = await admin
            .from('activity_feed')
            .select('actor, created_at, entity, metadata')
            .eq('trip_id', trip.id)
            .eq('verb', 'poll_closed')
            .gte('created_at', decisionAnnounceSince(now))
          const recent = recentDecisionsFromActivity((activityRows ?? []) as Parameters<typeof recentDecisionsFromActivity>[0], now)
          if (recent.length > 0) {
            const { data: decidedRows } = await admin
              .from('planning_sections')
              .select('id, title, status, metadata, options(id, title, status, price, currency, price_type)')
              .eq('trip_id', trip.id)
              .in('id', recent.map((r) => r.sectionId))
            const decided = (decidedRows ?? []) as unknown as DecidedSectionRow[]

            // "<Name> is booking it": only when a real, still-open Book to-do exists.
            const followupBySection = new Map<string, string>()
            for (const d of decided) {
              const f = d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata) ? (d.metadata as Record<string, unknown>).followup_action_id : null
              if (typeof f === 'string') followupBySection.set(d.id, f)
            }
            const bookerBySection = new Map<string, string>()
            if (followupBySection.size > 0) {
              const { data: bookActions } = await admin
                .from('trip_actions')
                .select('id, assigned_to, completed_at')
                .in('id', [...followupBySection.values()])
              const openAssignee = new Map<string, string>()
              for (const a of (bookActions ?? []) as Array<{ id: string; assigned_to: string | null; completed_at: string | null }>) {
                if (!a.completed_at && a.assigned_to) openAssignee.set(a.id, a.assigned_to)
              }
              const assigneeIds = [...new Set(openAssignee.values())]
              if (assigneeIds.length > 0) {
                const { data: assigneeRows } = await admin.from('users').select('id, first_name, full_name').in('id', assigneeIds)
                const nameOf = new Map<string, string>()
                for (const u of (assigneeRows ?? []) as Array<{ id: string; first_name: string | null; full_name: string | null }>) {
                  const first = u.first_name?.trim() || u.full_name?.trim().split(/\s+/)[0]
                  if (first) nameOf.set(u.id, first)
                }
                for (const [sectionId, actionId] of followupBySection) {
                  const who = openAssignee.get(actionId)
                  const name = who ? nameOf.get(who) : undefined
                  if (name) bookerBySection.set(sectionId, name)
                }
              }
            }

            // The activity row is only a hint (any participant can write one):
            // the announcement is built from the section's own stored state.
            const announcements: Array<{ r: (typeof recent)[number]; ann: NonNullable<ReturnType<typeof buildDecisionAnnouncement>> }> = []
            for (const r of recent) {
              const section = decided.find((d) => d.id === r.sectionId)
              if (!section) continue
              const ann = buildDecisionAnnouncement(section, APP_BASE_URL, trip.id, bookerBySection.get(section.id) ?? null, r.optionId)
              if (ann) announcements.push({ r, ann })
            }
            const candidateKeys = announcements.flatMap(({ ann }) => participantIds.map((u) => decisionDedupeKey(ann.sectionId, ann.optionId, u)))
            const alreadyAnnounced = new Set<string>()
            if (candidateKeys.length > 0) {
              const { data: sentRows } = await admin.from('notifications').select('dedupe_key').in('dedupe_key', candidateKeys)
              for (const row of (sentRows ?? []) as Array<{ dedupe_key: string }>) alreadyAnnounced.add(row.dedupe_key)
            }

            for (const { r, ann } of announcements) {
              for (const uid of decisionRecipients(participantIds, r.actor)) {
                const key = decisionDedupeKey(r.sectionId, ann.optionId, uid)
                if (alreadyAnnounced.has(key)) continue
                items.push({
                  tripId: trip.id,
                  tripName: trip.name,
                  userId: uid,
                  kind: DECISION_KIND,
                  entityType: 'planning_section',
                  entityId: r.sectionId,
                  dedupeKey: key,
                  description: `We have an answer: ${ann.headline}`,
                  deepLink: ann.link,
                  decision: { headline: ann.headline, details: ann.details },
                })
              }
            }
          }
        } catch (decisionError) {
          console.warn('[auto-chase] decision announcements failed for trip, continuing:', trip.id, decisionError instanceof Error ? decisionError.message : decisionError)
        }
      }
      } catch (tripError) {
        console.error('[auto-chase] trip failed, continuing with the next one:', trip.id, tripError)
      }
    }

    // ---- 1b. Action-deadline reminders: staged ladder across ALL trips ----
    // Unlike the opt-in chase kinds above, deadline reminders run for every
    // trip by default -- creating an action with a deadline is itself the
    // opt-in -- gated only by chase_settings.action_reminders (opt-OUT,
    // defaults to true; see ./chaseSettings.ts) and quiet hours. Each
    // (action, user, stage) fires at most once: trip_action_reminders rows
    // (written only after a successful email send) record what went out.
    // The per-user one-digest-per-day cap, the global email opt-out, and
    // the notifications log all still apply downstream.
    {
      const { data: actionTrips, error: actionTripsError } = await admin
        .from('trips')
        .select(
          'id, name, status, start_date, end_date, chase_settings, trip_actions!inner(id, title, assigned_to, deadline_kind, due_date, completed_at, section_id, trip_action_completions(user_id))'
        )
        .is('trip_actions.completed_at', null)
      if (actionTripsError) throw actionTripsError

      for (const trip of actionTrips ?? []) {
       // Same isolation as the main loop: one bad trip never stops the rest.
       try {
        // Skip when the organizer has explicitly turned off action
        // reminders, or during configured quiet hours -- both apply even
        // when the bundled chase engine (`enabled`) is off.
        if (!actionRemindersGateOpen(parseChaseSettings(trip.chase_settings), now)) continue
        // Finished trips (completed, or end date passed) get no more
        // deadline reminders -- previously overdue "before trip" actions
        // kept emailing people on ongoing and finished trips.
        if (!isTripOpenForReminders(trip, now)) continue
        // deno-lint-ignore no-explicit-any
        const openActions = (trip.trip_actions ?? []) as any[]
        const staged = openActions.flatMap((a) => {
          const dueDate = effectiveActionDueDate({
            deadline_kind: a.deadline_kind,
            due_date: a.due_date,
            tripStartDate: trip.start_date,
          })
          if (!dueDate) return []
          const stage = actionReminderStage(dueDate, now)
          return stage ? [{ action: a, dueDate, stage }] : []
        })
        if (staged.length === 0) continue
        const unclaimedAnyone = await fetchUnclaimedAnyoneActionIds(admin, staged.map((x) => x.action.id as string))

        const { data: actionParticipants } = await admin
          .from('trip_participants')
          .select('user_id, created_at, confirmation_status, active')
          .eq('trip_id', trip.id)
          .eq('active', true)
        const chaseableActionParticipants = (actionParticipants ?? []).filter(isChaseableParticipant)
        const actionParticipantIds = chaseableActionParticipants.map((p) => p.user_id)
        const joinedAtByUser = new Map(chaseableActionParticipants.map((p) => [p.user_id, p.created_at as string | null]))

        // Everything already sent for these actions, in one query per trip.
        const { data: sentRows } = await admin
          .from('trip_action_reminders')
          .select('action_id, user_id, stage')
          .in('action_id', staged.map((s) => s.action.id))
        const alreadySent = new Set((sentRows ?? []).map((r) => `${r.action_id}:${r.user_id}:${r.stage}`))

        // DERIVED completion: an action linked to a decision section counts
        // as complete for a user once they've voted in that section (see
        // src/features/actions/lib/actionStatus.ts -- derived-vote OR
        // manual-tick = complete). Without this, a section-linked action
        // keeps chasing someone who's already voted. One query per trip for
        // the sections any staged action here links to.
        const sectionIds = [...new Set(staged.map((s) => s.action.section_id as string | null).filter((id): id is string => !!id))]
        const sectionVoters = await fetchSectionVoters(admin, sectionIds)
        // A vote-linked action whose question is closed is no longer
        // required of anyone (nobody can vote any more) -- never chase it.
        const closedSectionIds = await fetchClosedSectionIds(admin, sectionIds)

        for (const { action: a, dueDate, stage } of staged) {
          // deno-lint-ignore no-explicit-any
          const completedBy = new Set<string>((a.trip_action_completions ?? []).map((c: any) => c.user_id))
          if (unclaimedAnyone.has(a.id)) continue
          if (a.assigned_to && !actionParticipantIds.includes(a.assigned_to)) continue
          const targets: string[] = a.assigned_to ? [a.assigned_to] : actionParticipantIds

          const chipLabel = actionDueChipLabel(dueDate, now)
          const deadlineLabel = formatDueDate(dueDate, a.deadline_kind)

          for (const uid of outstandingTargets(targets, a.section_id, completedBy, sectionVoters, closedSectionIds)) {
            if (alreadySent.has(`${a.id}:${uid}:${stage}`)) continue
            // Late joiners: no "Overdue" email for a deadline that had
            // already passed before they were on the trip.
            if (stage === 'overdue' && joinedAfterDueDate(joinedAtByUser.get(uid), dueDate)) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: uid,
              kind: stageKind(stage),
              entityType: 'trip_action',
              entityId: a.id,
              description: `${chipLabel}: "${a.title}" for "${trip.name}" (${deadlineLabel})`,
              deepLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.todo(a.id)),
              actionReminder: {
                actionId: a.id,
                stage,
                title: a.title,
                deadlineLabel,
                chipLabel,
                chipTone: stageChipTone(stage),
              },
            })
          }
        }
       } catch (tripError) {
        console.error('[auto-chase] action reminders failed for trip, continuing:', trip.id, tripError)
       }
      }
    }

    // ---- 2. Apply per-item reminder caps (max 3 then escalate) ----
    // Load prior notification counts for all candidate items in one query.
    const escalations: Array<{ trip_id: string; user_id: string; kind: string; entity_id: string; description: string }> = []
    const sendable: Array<ChaseItem & { seq: number }> = []

    if (items.length > 0) {
      const userIds = [...new Set(items.map((i) => i.userId))]
      const { data: priorNotifications } = await admin
        .from('notifications')
        .select('user_id, kind, entity_id, dedupe_key, sent_at')
        .in('user_id', userIds)
      const prior = priorNotifications ?? []

      // Per-trip max_reminders lookup.
      const maxRemindersByTrip = new Map(chaseTrips.map((t) => [t.id, t.settings.max_reminders]))

      for (const item of items) {
        // "We have an answer" is announced once, ever: its dedupe key (seq 1)
        // is checked when the item is built, so it is outside the reminder cap
        // and can never be escalated to the blockers board.
        if (item.kind === DECISION_KIND) {
          sendable.push({ ...item, seq: 1 })
          continue
        }
        const priorForItem = prior.filter(
          (n) => n.user_id === item.userId && n.kind === item.kind && n.entity_id === item.entityId
        )
        const maxReminders = maxRemindersByTrip.get(item.tripId) ?? DEFAULT_SETTINGS.max_reminders
        if (priorForItem.length >= maxReminders) {
          // Escalate: stop chasing, surface on the blockers board.
          escalations.push({
            trip_id: item.tripId,
            user_id: item.userId,
            kind: item.kind,
            entity_id: item.entityId,
            description: `${item.description} -- reminder cap reached, needs a personal nudge`,
          })
          continue
        }
        sendable.push({ ...item, seq: priorForItem.length + 1 })
      }
    }

    // ---- 3. Bundle per-user digests, apply 1-email/user/day cap, send ----
    const byUser = new Map<string, Array<ChaseItem & { seq: number }>>()
    for (const item of sendable) {
      const list = byUser.get(item.userId) ?? []
      list.push(item)
      byUser.set(item.userId, list)
    }

    let emailsSent = 0
    let usersSkippedDailyCap = 0
    let usersSkippedOptOut = 0
    const chaseDrafts: Array<{ user_id: string; email: string | null; name: string | null; items: Array<{ kind: string; description: string; deep_link: string }> }> = []

    for (const [userId, userItems] of byUser) {
      // Daily cap: has this user already received a chase digest today?
      const { count: todayCount } = await admin
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('sent_at', todayStartIso)
        .like('dedupe_key', 'chase:%')
      if ((todayCount ?? 0) > 0) {
        usersSkippedDailyCap++
        continue
      }

      const { data: userRow } = await admin
        .from('users')
        .select('email, full_name, first_name, email_notifications_enabled')
        .eq('id', userId)
        .single()

      // Single funnel point for the suppression decision (see
      // ./emailSuppression.ts) -- both the opt-in chase kinds and the
      // opt-out action-deadline ladder built their items into this same
      // per-user digest above, so this one check covers every email path.
      const suppression = decideEmailSuppression({
        emailChannelAvailable: emailSender.available,
        hasEmailAddress: !!userRow?.email,
        emailNotificationsEnabled: userRow?.email_notifications_enabled,
      })
      const canEmail = suppression.canSend

      // Compose the digest via the shared "Tim's Trip Planner" template:
      // one section per trip -- deadline'd actions as a table, every other
      // open loop as a list. (The WhatsApp-ready draft keeps the raw items.)
      const greetingName = userRow?.first_name || userRow?.full_name?.split(' ')[0] || 'there'
      const sectionsByTrip = new Map<string, DigestTripSection>()
      for (const i of userItems) {
        let section = sectionsByTrip.get(i.tripId)
        if (!section) {
          section = {
            tripName: i.tripName,
            tripLink: emailLink(APP_BASE_URL, i.tripId),
            actionRows: [],
            otherLines: [],
            todosLink: emailLink(APP_BASE_URL, i.tripId, DEEP_LINKS.todos()),
          }
          sectionsByTrip.set(i.tripId, section)
        }
        if (i.decision) {
          ;(section.decisions ??= []).push({ headline: i.decision.headline, details: i.decision.details, link: i.deepLink })
        } else if (i.actionReminder) {
          section.actionRows.push({
            title: i.actionReminder.title,
            deadlineLabel: i.actionReminder.deadlineLabel,
            chipLabel: i.actionReminder.chipLabel,
            chipTone: i.actionReminder.chipTone,
            link: i.deepLink,
          })
        } else {
          section.otherLines.push({ description: i.description, link: i.deepLink })
        }
      }
      const digestSections = [...sectionsByTrip.values()]
      const rendered = renderDigestEmail({
        greetingName,
        sections: digestSections,
        // One trip: the button opens its to-dos (or, for a lone "We have an
        // answer", that question). Several trips: the app home.
        appUrl:
          digestSections.length === 1
            ? digestSections[0].actionRows.length + digestSections[0].otherLines.length === 0 && digestSections[0].decisions?.length === 1
              ? digestSections[0].decisions[0].link
              : digestSections[0].todosLink!
            : APP_BASE_URL,
      })

      // Never send an empty digest. Structurally every user in byUser has
      // >=1 item so this shouldn't fire, but it is the hard guarantee that
      // no "0 things need your attention" email can ever go out; skipping
      // BEFORE any send/log also means nothing is burned for next run.
      if (rendered.itemCount === 0) continue

      let channel: string
      if (canEmail) {
        try {
          await emailSender.send({
            toEmail: userRow!.email,
            toName: userRow?.full_name ?? undefined,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
          })
          channel = 'email'
          emailsSent++
        } catch (sendError) {
          console.error('[auto-chase] email send failed for user', userId, sendError)
          channel = 'skipped'
        }
      } else {
        channel = 'skipped'
        if (suppression.skipReason === 'opt_out') usersSkippedOptOut++
      }

      // Mark action-reminder stages as sent -- ONLY on a real email send, so
      // a skipped/failed digest retries on the next daily run instead of
      // silently burning the once-per-stage budget.
      if (channel === 'email') {
        const reminderRows = userItems
          .filter((i) => i.actionReminder)
          .map((i) => ({
            action_id: i.actionReminder!.actionId,
            trip_id: i.tripId,
            user_id: userId,
            stage: i.actionReminder!.stage,
          }))
        if (reminderRows.length > 0) {
          const { error: reminderError } = await admin
            .from('trip_action_reminders')
            .upsert(reminderRows, { onConflict: 'action_id,user_id,stage', ignoreDuplicates: true })
          if (reminderError) {
            console.error('[auto-chase] trip_action_reminders upsert failed:', reminderError)
          }
        }
      }

      if (channel === 'skipped') {
        chaseDrafts.push({
          user_id: userId,
          email: userRow?.email ?? null,
          name: userRow?.full_name ?? null,
          items: userItems.map((i) => ({ kind: i.kind, description: i.description, deep_link: i.deepLink })),
        })
      }

      // ---- 4. Log every item to notifications (dedupe_key enforces caps) ----
      for (const item of userItems) {
        const dedupeKey = item.dedupeKey ?? `chase:${item.kind}:${item.entityId}:${userId}:${item.seq}`
        const { error: insertError } = await admin.from('notifications').insert({
          trip_id: item.tripId,
          user_id: userId,
          kind: item.kind,
          entity_type: item.entityType,
          entity_id: item.entityId,
          channel,
          dedupe_key: dedupeKey,
        })
        if (insertError) {
          // Unique violation on dedupe_key = a concurrent/duplicate run
          // already logged this reminder -- fine, skip silently.
          if (!insertError.message?.includes('duplicate')) {
            console.error('[auto-chase] notification insert failed:', insertError)
          }
        }
      }
    }

    const result = {
      success: true,
      scanned_trips: chaseTrips.length,
      open_loops_found: items.length,
      emails_sent: emailsSent,
      users_skipped_daily_cap: usersSkippedDailyCap,
      users_skipped_opt_out: usersSkippedOptOut,
      waitlist_offers_sent: waitlistOffersSent,
      waitlist_feature_available: hasWaitlistColumn,
      escalations,
      stages_moved: stagesMoved,
      auto_decide: autoDecide,
      decision_announcements_found: items.filter((i) => i.kind === DECISION_KIND).length,
      chase_drafts: chaseDrafts,
      email_channel_available: emailSender.available,
    }

    console.log('[auto-chase] Done:', JSON.stringify({ ...result, chase_drafts: chaseDrafts.length, escalations: escalations.length }))

    return jsonResponse(result)
  } catch (error) {
    return errorResponse(error)
  }
})

/**
 * Test entrypoint: compose ONE user's action digest for ONE trip and send it
 * to a single explicitly-supplied address. Guarded so it cannot fan out:
 *  - same cron/service-role auth as the sweep (checked before we get here);
 *  - sends to exactly `to_email` -- never to participants' real addresses;
 *  - writes nothing: no notifications rows, no trip_action_reminders rows,
 *    so the real once-per-stage ladder is untouched by testing.
 * Includes EVERY open action relevant to the user (assigned to them, or
 * whole-group without their completion) regardless of reminder window, so
 * the email demonstrates the full table with live status chips.
 */
async function handleTestDigest(
  admin: SupabaseClient,
  emailSender: EmailSender,
  now: Date,
  params: { trip_id?: string; user_id?: string; to_email?: string }
): Promise<Response> {
  const { trip_id, user_id, to_email } = params
  if (!trip_id || !user_id || !to_email) {
    return jsonResponse({ success: false, error: 'test_digest requires trip_id, user_id and to_email' }, 400)
  }

  const { data: trip } = await admin.from('trips').select('id, name, start_date').eq('id', trip_id).single()
  if (!trip) return jsonResponse({ success: false, error: 'trip not found' }, 404)

  const { data: userRow } = await admin.from('users').select('first_name, full_name').eq('id', user_id).single()
  const { data: participants } = await admin
    .from('trip_participants')
    .select('user_id')
    .eq('trip_id', trip_id)
    .eq('active', true)
  if (!(participants ?? []).some((p) => p.user_id === user_id)) {
    return jsonResponse({ success: false, error: 'user is not an active participant of the trip' }, 400)
  }

  const { data: actions } = await admin
    .from('trip_actions')
    .select('id, title, assigned_to, deadline_kind, due_date, section_id, trip_action_completions(user_id)')
    .eq('trip_id', trip_id)
    .is('completed_at', null)

  // DERIVED completion (see the same block in the main sweep above): a
  // section-linked action is complete for this user once they've voted in
  // that section, even without a trip_action_completions row.
  const sectionIds = [...new Set((actions ?? []).map((a) => a.section_id).filter((id): id is string => !!id))]
  const sectionVoters = await fetchSectionVoters(admin, sectionIds)
  const closedSectionIds = await fetchClosedSectionIds(admin, sectionIds)

  const unclaimedAnyone = await fetchUnclaimedAnyoneActionIds(admin, (actions ?? []).map((a) => a.id))
  const rows: Array<{ dueDate: string; row: DigestActionRow }> = []
  for (const a of actions ?? []) {
    if (unclaimedAnyone.has(a.id)) continue
    if (a.assigned_to && a.assigned_to !== user_id) continue
    // deno-lint-ignore no-explicit-any
    const completedBy = new Set<string>((a.trip_action_completions ?? []).map((c: any) => c.user_id))
    if (outstandingTargets([user_id], a.section_id, completedBy, sectionVoters, closedSectionIds).length === 0) continue
    const dueDate = effectiveActionDueDate({
      deadline_kind: a.deadline_kind,
      due_date: a.due_date,
      tripStartDate: trip.start_date,
    })
    if (!dueDate) continue
    rows.push({
      dueDate,
      row: {
        title: a.title,
        link: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.todo(a.id)),
        deadlineLabel: formatDueDate(dueDate, a.deadline_kind),
        chipLabel: actionDueChipLabel(dueDate, now),
        chipTone: stageChipTone(actionReminderStage(dueDate, now)),
      },
    })
  }
  rows.sort((x, y) => x.dueDate.localeCompare(y.dueDate))

  // Same guarantee as the sweep: an empty digest is never sent -- not even
  // from the test entrypoint (this exact gap produced the 2026-07-19
  // "Japan 2026: 0 things need your attention" incident email).
  if (rows.length === 0) {
    return jsonResponse({
      success: true,
      test: true,
      sent: false,
      action_count: 0,
      reason: `no open dated actions for this user on "${trip.name}" -- empty digests are not sent`,
    })
  }

  const rendered = renderDigestEmail({
    greetingName: userRow?.first_name || userRow?.full_name?.split(' ')[0] || 'there',
    sections: [
      {
        tripName: trip.name,
        tripLink: emailLink(APP_BASE_URL, trip.id),
        actionRows: rows.map((r) => r.row),
        otherLines: [],
        todosLink: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.todos()),
      },
    ],
    appUrl: emailLink(APP_BASE_URL, trip.id, DEEP_LINKS.todos()),
  })

  if (!emailSender.available) {
    return jsonResponse({
      success: false,
      error: 'no email provider configured (RESEND_API_KEY / BREVO_API_KEY unset)',
      subject: rendered.subject,
      text_preview: rendered.text,
    })
  }

  const receipt = await emailSender.send({
    toEmail: to_email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  })

  return jsonResponse({
    success: true,
    test: true,
    sent_to: to_email,
    subject: rendered.subject,
    action_count: rows.length,
    receipt,
  })
}
