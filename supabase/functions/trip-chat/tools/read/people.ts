/** get_people: who is on the trip, their reply to "Are you coming?" in plain words, and whether they have added travel details. */
import type { ToolModule } from '../types.ts'
import { getMyTravelEvents, travelEventAirportCode, travelEventFlightRef } from '../../../_shared/todos/deps/travelDetails.ts'
import type { TimelineEvent } from '../../../_shared/todos/deps/timelineEvent.ts'
import { S, dateWords, failed, loadData, nameOf, readTool, replyWordsFor, timeWords, z } from './shared.ts'
import { wrap } from './questions.ts'

function travelLine(event: TimelineEvent & { event_date?: string; start_time?: string | null }): string {
  const parts = [dateWords(event.event_date ?? null), timeWords(event.start_time ?? null)].filter(Boolean)
  const ref = travelEventFlightRef(event)
  const airport = travelEventAirportCode(event)
  return [parts.join(' '), ref ? `flight ${ref}` : null, airport ? `at ${airport}` : null].filter(Boolean).join(', ') || 'added'
}

export const getPeopleTool: ToolModule = readTool({
  name: 'get_people',
  description:
    'Who is on the trip: for each person their role (organiser or not), their reply to "Are you coming?" in the app\'s words (Going, Not sure, Not going, No reply yet, On the waitlist) when reply tracking is switched on for the trip, who they are waiting on if they said "if X comes", and whether they have added their arrival and departure details (with the times). Includes counts per reply.',
  statusLabel: 'Checking who is coming…',
  access: 'trip',
  inputSchema: S.object({}),
  schema: z.object({}).passthrough(),
  run: async (_args, ctx) => {
    const data = await loadData(ctx)
    if (!data) return failed()
    const tracking = data.trip.confirmation_enabled === true
    const reply = replyWordsFor(data.trip, data.participants, ctx.now)
    const events = data.timeline as unknown as Array<TimelineEvent & { event_date?: string; start_time?: string | null }>
    const people = data.participants.map((p) => {
      const mine = getMyTravelEvents(events, p.user_id)
      const row: Record<string, unknown> = { person: nameOf(ctx, p.user_id) }
      if (p.role === 'organizer') row.role = 'Organiser'
      if (tracking) {
        row.reply = reply.words(p.user_id)
        const waitingOn: string[] = Array.isArray(p.conditional_user_ids) ? p.conditional_user_ids : []
        if (p.confirmation_status === 'conditional' && waitingOn.length > 0) row.depends_on = waitingOn.map((id) => nameOf(ctx, id))
        if (p.confirmation_status === 'conditional' && p.conditional_date) row.will_decide_by = dateWords(p.conditional_date)
      }
      row.travel_details = {
        arrival: mine.arrival ? wrap(travelLine(mine.arrival as never)) : 'not added yet',
        departure: mine.departure ? wrap(travelLine(mine.departure as never)) : 'not added yet',
      }
      return row
    })
    const counts: Record<string, number> = {}
    if (tracking) for (const p of data.participants) counts[reply.words(p.user_id)] = (counts[reply.words(p.user_id)] ?? 0) + 1
    return {
      content: {
        reply_tracking: tracking ? 'on' : 'off: replies to "Are you coming?" are not being tracked for this trip',
        count: people.length,
        ...(tracking ? { replies: counts } : {}),
        people,
      },
    }
  },
})
