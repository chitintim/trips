// Nudge Draft Edge Function (NEW, plan §14): AI-drafted, WhatsApp-ready
// copy for one blocker/person, with a deep link back into the app. The
// organizer taps "nudge" on a blocker, gets a short friendly message to
// copy to WhatsApp.
//
// Input per NudgeDraftRequest (trip_id, target_user_id, blocker_type,
// blocker_entity_id?, tone_hint?) -> structured output against
// NudgeDraftResponse. Rate limit: 20/day/user.
//
// The deep link is computed IN CODE (deterministic, per blocker type) and
// overrides whatever the model returns -- never trust a model-authored URL.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, jsonResponse } from '../_shared/errors.ts'
import { callerClient, requireUser, requireTripParticipant } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { createMessage, padForCaching, CLAUDE_MODEL } from '../_shared/anthropic.ts'
import { logAiUsage } from '../_shared/usage.ts'
import {
  NudgeDraftRequestSchema,
  NudgeDraftResponseSchema,
  NudgeDraftResponseJsonSchema,
  type BlockerType,
} from '../_shared/contracts/nudgeDraft.ts'

const APP_BASE_URL = Deno.env.get('APP_BASE_URL') ?? 'https://chitintim.github.io/trips'

const SYSTEM_PROMPT_STATIC = `You write short, friendly nudge messages that a trip organizer sends to a friend over WhatsApp to unblock trip planning. Rules:

- 1-3 sentences, warm and casual, never guilt-trippy or formal. Emojis: at most one, only if it fits.
- Mention the specific thing they need to do (vote, RSVP, claim their items, pay someone back) and any relevant detail provided (deadline, amount, poll name).
- Include the deep link you are given VERBATIM at the end of the message so they can act in one tap. Do not invent or alter the link.
- Write in the first person as the organizer ("Hey Alex! Quick one -- ...").
- Respect any tone hint provided.
- Fill the response schema exactly: message (the full text incl. link), deep_link (echo the link you were given), blocker_type and target_user_id (echo the values you were given).`

/** Deterministic deep link per blocker type -- computed in code, not by the model. */
async function computeDeepLink(
  // deno-lint-ignore no-explicit-any
  client: any,
  tripId: string,
  blockerType: BlockerType,
  blockerEntityId?: string
): Promise<string> {
  if (blockerType === 'unclaimed_items' && blockerEntityId) {
    // blocker_entity_id is the expense id -- resolve its claim-link code.
    const { data } = await client
      .from('expense_allocation_links')
      .select('code')
      .eq('expense_id', blockerEntityId)
      .maybeSingle()
    if (data?.code) {
      return `${APP_BASE_URL}/claim/${data.code}`
    }
  }
  // Everything else lands on the trip page (the app's needs-attention strip
  // surfaces the specific action); finer-grained routes can be added as the
  // frontend grows them.
  return `${APP_BASE_URL}/${tripId}`
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  try {
    const supabaseClient = callerClient(req)
    const user = await requireUser(supabaseClient)

    const request = NudgeDraftRequestSchema.parse(await req.json())

    await requireTripParticipant(supabaseClient, request.trip_id, user.id)
    await consumeRateLimit(supabaseClient, RATE_LIMITS.nudgeDraft)

    // Gather minimal context under the caller's JWT: trip name, target's
    // first name, and blocker-specific detail.
    const [tripRes, targetRes] = await Promise.all([
      supabaseClient.from('trips').select('id, name, location').eq('id', request.trip_id).single(),
      supabaseClient.from('users').select('full_name, first_name, email').eq('id', request.target_user_id).single(),
    ])
    if (tripRes.error || !tripRes.data) throw new Error('Trip not found')

    const targetName =
      targetRes.data?.first_name ||
      targetRes.data?.full_name?.split(' ')[0] ||
      targetRes.data?.email?.split('@')[0] ||
      'there'

    // Blocker-specific context (best-effort, still under caller's JWT).
    let blockerDetail = ''
    if (request.blocker_type === 'unclaimed_items' && request.blocker_entity_id) {
      const { data } = await supabaseClient
        .from('expenses')
        .select('description, amount, currency')
        .eq('id', request.blocker_entity_id)
        .maybeSingle()
      if (data) blockerDetail = `Receipt "${data.description}" (${data.currency} ${data.amount}) has items awaiting their claim.`
    } else if (request.blocker_type === 'unvoted_poll' && request.blocker_entity_id) {
      const { data } = await supabaseClient
        .from('planning_sections')
        .select('title, vote_deadline')
        .eq('id', request.blocker_entity_id)
        .maybeSingle()
      if (data) blockerDetail = `Poll "${data.title}" needs their vote${data.vote_deadline ? ` before ${data.vote_deadline}` : ''}.`
    } else if (request.blocker_type === 'unpaid_settlement' && request.blocker_entity_id) {
      const { data } = await supabaseClient
        .from('settlements')
        .select('amount, currency, to_user_id')
        .eq('id', request.blocker_entity_id)
        .maybeSingle()
      if (data) blockerDetail = `They have an unpaid settlement of ${data.currency ?? ''} ${data.amount}.`
    } else if (request.blocker_type === 'pending_rsvp') {
      blockerDetail = 'They have not confirmed whether they are joining the trip yet.'
    } else if (request.blocker_type === 'unbooked_won_poll') {
      blockerDetail = 'A poll they are involved in has a winning option that still needs booking.'
    } else if (request.blocker_type === 'expiring_cancellation_window') {
      blockerDetail = 'A free-cancellation deadline related to them is approaching.'
    }

    const deepLink = await computeDeepLink(supabaseClient, request.trip_id, request.blocker_type, request.blocker_entity_id)

    const userPrompt = `Trip: "${tripRes.data.name}" (${tripRes.data.location})
Recipient first name: ${targetName}
Recipient user id: ${request.target_user_id}
Blocker type: ${request.blocker_type}
Blocker detail: ${blockerDetail || '(none available -- keep the message generic but specific to the blocker type)'}
Deep link (include verbatim at the end of the message): ${deepLink}
${request.tone_hint ? `Tone hint from the organizer: ${request.tone_hint}` : ''}

Draft the nudge message now.`

    const response = await createMessage({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: padForCaching(SYSTEM_PROMPT_STATIC),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: { type: 'json_schema', schema: NudgeDraftResponseJsonSchema.schema as Record<string, unknown>},
      },
    })

    await logAiUsage({ userId: user.id, tripId: request.trip_id, functionName: 'nudge-draft', model: response.model, usage: response.usage })

    const textBlock = response.content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    if (!textBlock?.text) throw new Error('No content in Claude response')

    const draft = NudgeDraftResponseSchema.parse(JSON.parse(textBlock.text))

    // Never trust model-authored links/ids: override with computed values.
    const result = {
      ...draft,
      deep_link: deepLink,
      blocker_type: request.blocker_type,
      target_user_id: request.target_user_id,
    }

    return jsonResponse({ success: true, data: result })
  } catch (error) {
    return errorResponse(error)
  }
})
