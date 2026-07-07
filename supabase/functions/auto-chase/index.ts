// Auto-Chase Engine Edge Function (NEW, plan §14). Cron-invoked (like
// refresh-fx-rates), runs with the SERVICE ROLE (this is one of the plan-
// sanctioned service-role surfaces: scanning open loops across trips and
// writing the notifications log -- it never writes trip data).
//
// Scans every open commitment loop and emails each laggard a deep link to
// their exact action:
//   - unclaimed items on expenses w/ participant_ids past the trip's
//     chase threshold;
//   - polls approaching vote_deadline with missing votes;
//   - pending RSVPs near the confirmation deadline;
//   - stated-date conditionals: conditional_date arrived;
//   - waitlist lifecycle: freed spots -> claim offer to first in line
//     (feature-detected -- skipped if trip_participants.waitlist_offer_
//     expires_at doesn't exist yet, it ships in a later feature migration);
//   - settlements 'suggested'/'marked_paid' older than N days.
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
// (trips.chase_settings jsonb: {enabled, delay_hours, quiet_hours:{start,
// end}, max_reminders}). Every send logged to notifications; dedupe_key
// (kind:entity:user:seq) enforces the caps at the DB level.
//
// Email channel: Brevo REST if BREVO_API_KEY is set; otherwise sends are
// skipped, logged with channel='skipped', and returned as WhatsApp-ready
// chase_drafts for the blockers board (plan: degrade gracefully).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, jsonResponse, UnauthorizedError } from '../_shared/errors.ts'
import { serviceClient } from '../_shared/supabaseClients.ts'
import { getEmailSender } from '../_shared/emailSender.ts'

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'https://chitintim.github.io/trips'

interface ChaseSettings {
  enabled: boolean
  delay_hours: number
  quiet_hours: { start: number; end: number } | null
  max_reminders: number
}

const DEFAULT_SETTINGS: ChaseSettings = {
  enabled: false, // opt-IN per trip: never auto-email trips that haven't turned it on
  delay_hours: 48,
  quiet_hours: null,
  max_reminders: 3,
}

function parseChaseSettings(raw: unknown): ChaseSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS
  const r = raw as Record<string, unknown>
  return {
    enabled: r.enabled === true,
    delay_hours: typeof r.delay_hours === 'number' ? r.delay_hours : DEFAULT_SETTINGS.delay_hours,
    quiet_hours:
      r.quiet_hours && typeof r.quiet_hours === 'object'
        ? (r.quiet_hours as { start: number; end: number })
        : null,
    max_reminders: typeof r.max_reminders === 'number' ? r.max_reminders : DEFAULT_SETTINGS.max_reminders,
  }
}

function inQuietHours(settings: ChaseSettings, now: Date): boolean {
  if (!settings.quiet_hours) return false
  const hour = now.getUTCHours()
  const { start, end } = settings.quiet_hours
  // Quiet window may wrap midnight (e.g. 22 -> 8).
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}

/** One open loop targeting one user. */
interface ChaseItem {
  tripId: string
  tripName: string
  userId: string
  kind:
    | 'unclaimed_items'
    | 'unvoted_poll'
    | 'pending_rsvp'
    | 'conditional_date_arrived'
    | 'waitlist_offer'
    | 'unpaid_settlement'
    | 'unconfirmed_settlement'
    | 't30_no_transport'
    | 't14_missing_arrival'
    | 't1_checkin'
  entityType: string
  entityId: string
  description: string
  deepLink: string
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

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    // Cron-only: require the service-role key as the bearer token. (The
    // platform's verify_jwt already rejects unsigned calls; this check
    // additionally rejects ordinary user JWTs -- no user may trigger a
    // chase sweep.)
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    if (!token || token !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      throw new UnauthorizedError('auto-chase is cron/service-role only')
    }

    const admin = serviceClient()
    const emailSender = getEmailSender()
    const now = new Date()
    const todayStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()

    const hasWaitlistColumn = await waitlistColumnExists(admin)

    // ---- 1. Load chase-enabled trips (opt-in via trips.chase_settings.enabled) ----
    const { data: trips, error: tripsError } = await admin
      .from('trips')
      .select('id, name, status, capacity_limit, confirmation_deadline, chase_settings, start_date, end_date')
      .not('chase_settings', 'is', null)
    if (tripsError) throw tripsError

    const chaseTrips = (trips ?? [])
      .map((t) => ({ ...t, settings: parseChaseSettings(t.chase_settings) }))
      .filter((t) => t.settings.enabled && !inQuietHours(t.settings, now))

    const items: ChaseItem[] = []
    const waitlistOffersSent: Array<{ trip_id: string; user_id: string; expires_at: string }> = []

    for (const trip of chaseTrips) {
      const tripLink = `${APP_BASE_URL}/${trip.id}`

      // Active participants (used by several loops below).
      const { data: participants } = await admin
        .from('trip_participants')
        .select('user_id, role, confirmation_status, conditional_type, conditional_date, created_at')
        .eq('trip_id', trip.id)
        .eq('active', true)
      const activeParticipants = participants ?? []
      const participantIds = activeParticipants.map((p) => p.user_id)

      // ---- a. Unclaimed items on itemized expenses past threshold ----
      {
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
          const targets: string[] = (e.participant_ids && e.participant_ids.length > 0 ? e.participant_ids : participantIds)
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
              description: `Claim your items on "${e.description}" (${e.currency} ${e.amount})`,
              deepLink: claimCode ? `${APP_BASE_URL}/claim/${claimCode}` : tripLink,
            })
          }
        }
      }

      // ---- b. Polls approaching vote_deadline with missing votes ----
      {
        const { data: sections } = await admin
          .from('planning_sections')
          .select('id, title, vote_deadline, options(id, option_votes(user_id))')
          .eq('trip_id', trip.id)
          .not('vote_deadline', 'is', null)
          .gt('vote_deadline', now.toISOString())
          .lt('vote_deadline', hoursAheadIso(48, now))
        for (const s of sections ?? []) {
          const voted = new Set(
            // deno-lint-ignore no-explicit-any
            (s.options ?? []).flatMap((o: any) => (o.option_votes ?? []).map((v: any) => v.user_id))
          )
          for (const uid of participantIds) {
            if (voted.has(uid)) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: uid,
              kind: 'unvoted_poll',
              entityType: 'planning_section',
              entityId: s.id,
              description: `Vote on "${s.title}" before ${new Date(s.vote_deadline).toUTCString()}`,
              deepLink: tripLink,
            })
          }
        }
      }

      // ---- c. Pending RSVPs near the confirmation deadline ----
      if (trip.confirmation_deadline) {
        const deadline = new Date(trip.confirmation_deadline)
        const within72h = deadline.getTime() - now.getTime() < 72 * 3600_000 && deadline.getTime() > now.getTime()
        if (within72h) {
          for (const p of activeParticipants) {
            if (p.confirmation_status === 'pending' || p.confirmation_status === 'interested') {
              items.push({
                tripId: trip.id,
                tripName: trip.name,
                userId: p.user_id,
                kind: 'pending_rsvp',
                entityType: 'trip_participant',
                entityId: trip.id,
                description: `Confirm whether you're joining "${trip.name}" -- deadline ${deadline.toUTCString()}`,
                deepLink: tripLink,
              })
            }
          }
        }
      }

      // ---- d. Stated-date conditionals: conditional_date arrived ----
      {
        const todayStr = now.toISOString().split('T')[0]
        for (const p of activeParticipants) {
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
              description: `You said you'd know by ${p.conditional_date} -- can you confirm your spot on "${trip.name}" now?`,
              deepLink: tripLink,
            })
          }
        }
      }

      // ---- e. Waitlist lifecycle (feature-detected) ----
      if (hasWaitlistColumn && trip.capacity_limit) {
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
              description: `A spot opened up on "${trip.name}"! Claim it before ${new Date(expiresAt).toUTCString()} or it passes to the next person.`,
              deepLink: tripLink,
            })
            spotsToOffer--
          }
        }
      }

      // ---- f. Settlements 'suggested'/'marked_paid' older than N days ----
      {
        const staleDays = 3
        const { data: settlements } = await admin
          .from('settlements')
          .select('id, from_user_id, to_user_id, amount, currency, status, created_at')
          .eq('trip_id', trip.id)
          .in('status', ['suggested', 'marked_paid'])
          .lt('created_at', hoursAgoIso(staleDays * 24, now))
        for (const s of settlements ?? []) {
          if (s.status === 'suggested') {
            // Chase the payer to pay.
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: s.from_user_id,
              kind: 'unpaid_settlement',
              entityType: 'settlement',
              entityId: s.id,
              description: `Settle up ${s.currency ?? ''} ${s.amount} for "${trip.name}"`,
              deepLink: tripLink,
            })
          } else {
            // marked_paid: chase the recipient to confirm receipt.
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: s.to_user_id,
              kind: 'unconfirmed_settlement',
              entityType: 'settlement',
              entityId: s.id,
              description: `Confirm you received ${s.currency ?? ''} ${s.amount} for "${trip.name}"`,
              deepLink: tripLink,
            })
          }
        }
      }

      // ---- Date-intelligence T-minus kinds (UX_REDESIGN.md Part 3) ----
      // Shared "days until start" for the trip, used by both t30 and t14.
      const daysUntilStart = trip.start_date
        ? Math.floor((new Date(trip.start_date + 'T00:00:00Z').getTime() - now.getTime()) / 86_400_000)
        : null

      // ---- g. t30_no_transport: T-30, no flight/transport booking or plan
      // item exists yet -> organizer-only nudge (a trip-wide gap, not a
      // per-person one; a single flight/transport item covers everyone). ----
      if (daysUntilStart != null && daysUntilStart <= 30 && daysUntilStart >= 0) {
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
      if (daysUntilStart != null && daysUntilStart <= 14 && daysUntilStart >= 0) {
        const { data: travelEvents } = await admin
          .from('trip_timeline_events')
          .select('participant_ids')
          .eq('trip_id', trip.id)
          .in('category', ['flight', 'transfer'])
        const events = travelEvents ?? []
        const everyoneCovered = events.some((e) => e.participant_ids === null)
        if (!everyoneCovered) {
          const coveredIds = new Set(events.flatMap((e) => e.participant_ids ?? []))
          for (const p of activeParticipants) {
            if (coveredIds.has(p.user_id)) continue
            items.push({
              tripId: trip.id,
              tripName: trip.name,
              userId: p.user_id,
              kind: 't14_missing_arrival',
              entityType: 'trip_participant',
              entityId: trip.id,
              description: `"${trip.name}" is 2 weeks away -- add your arrival/departure details so the group knows when you're around.`,
              deepLink: tripLink,
            })
          }
        }
      }

      // ---- i. t1_checkin: T-1, flight bookings with a confirmation_ref
      // (something to actually check in for) -> nudge whoever booked it. ----
      if (daysUntilStart === 1) {
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
            deepLink: tripLink,
          })
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

      const optedOut = userRow?.email_notifications_enabled === false
      const canEmail = emailSender.available && !optedOut && !!userRow?.email

      // Compose the digest (used for the email AND the WhatsApp-ready draft).
      const greetingName = userRow?.first_name || userRow?.full_name?.split(' ')[0] || 'there'
      const lines = userItems.map((i) => `• ${i.description}\n  ${i.deepLink}`)
      const text = `Hi ${greetingName},\n\nA few things on your trips are waiting on you:\n\n${lines.join('\n\n')}\n\nThanks!\n(You can turn these emails off in your profile settings.)`
      const subject = userItems.length === 1
        ? `Action needed: ${userItems[0].tripName}`
        : `${userItems.length} things waiting on you across your trips`

      let channel: string
      if (canEmail) {
        try {
          await emailSender.send({
            toEmail: userRow!.email,
            toName: userRow?.full_name ?? undefined,
            subject,
            text,
          })
          channel = 'email'
          emailsSent++
        } catch (sendError) {
          console.error('[auto-chase] email send failed for user', userId, sendError)
          channel = 'skipped'
        }
      } else {
        channel = 'skipped'
        if (optedOut) usersSkippedOptOut++
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
        const dedupeKey = `chase:${item.kind}:${item.entityId}:${userId}:${item.seq}`
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
      chase_drafts: chaseDrafts,
      email_channel_available: emailSender.available,
    }

    console.log('[auto-chase] Done:', JSON.stringify({ ...result, chase_drafts: chaseDrafts.length, escalations: escalations.length }))

    return jsonResponse(result)
  } catch (error) {
    return errorResponse(error)
  }
})
