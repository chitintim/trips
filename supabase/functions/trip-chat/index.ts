// Trip Chat AI Assistant Edge Function
// Shared chat visible to all trip participants, with write actions for organizers only

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface TimelineAction {
  type: 'create_event' | 'update_event' | 'delete_event'
  event_id?: string
  event_date?: string
  start_time?: string
  end_time?: string
  all_day?: boolean
  title?: string
  description?: string
  category?: string
  location?: string
  event_title?: string // for summary display
}

interface LLMResponse {
  message: string
  actions?: TimelineAction[]
}

function buildSystemPrompt(
  tripContext: any,
  isOrganizer: boolean,
  userName: string
): string {
  const { trip, participants, sections, expenses, timelineEvents } = tripContext

  const participantList = participants
    .map((p: any) => `- ${p.user?.full_name || p.user?.email} (${p.role})`)
    .join('\n')

  // Build a user_id -> name lookup from participants
  const nameMap: Record<string, string> = {}
  for (const p of participants) {
    nameMap[p.user_id] = p.user?.full_name || p.user?.email || 'Unknown'
  }

  const sectionSummary = sections
    .map((s: any) => {
      const opts = (s.options || [])
        .map((o: any) => {
          const selections = (o.selections || []) as Array<{ user_id: string }>
          const selectedBy = selections.map((sel: any) => nameMap[sel.user_id] || 'Unknown')
          const selectionInfo = selectedBy.length > 0 ? ` — selected by: ${selectedBy.join(', ')}` : ''
          return `  - ${o.title} [${o.status}]${o.price ? ` ${o.currency || ''}${o.price}` : ''}${selectionInfo}`
        })
        .join('\n')
      return `${s.title} (${s.section_type}, ${s.status}):\n${opts || '  (no options)'}`
    })
    .join('\n\n')

  const eventSummary = timelineEvents.length > 0
    ? timelineEvents
      .map((e: any) => `- ${e.event_date} ${e.start_time || 'all day'}: ${e.title} [${e.category}]${e.location ? ` @ ${e.location}` : ''}`)
      .join('\n')
    : '(no events yet)'

  const expenseSummary = expenses.length > 0
    ? `${expenses.length} expenses totaling ${expenses.reduce((sum: number, e: any) => sum + e.amount, 0).toFixed(2)} ${expenses[0]?.currency || 'GBP'}`
    : '(no expenses yet)'

  let roleInstructions: string
  if (isOrganizer) {
    roleInstructions = `The current user "${userName}" is an ORGANIZER. They can ask you to create, update, or delete timeline events.

When they ask to add/create events, return actions in the "actions" array. Each action should be:
- type: "create_event" — include event_date (YYYY-MM-DD), title, category, and optionally start_time (HH:MM), end_time, description, location, all_day
- type: "update_event" — include event_id and fields to change
- type: "delete_event" — include event_id

Valid categories: flight, accommodation, transport, activity, dining, transfer, meeting_point, free_time, other

You can create multiple events in a single response (e.g., when importing a full itinerary).
Always include event_title in each action for display purposes.`
  } else {
    roleInstructions = `The current user "${userName}" is a PARTICIPANT (not an organizer). They can ask questions about the trip, but you MUST NOT return any actions. Do NOT include an "actions" array in your response. If they ask to change something, politely tell them only organizers can make changes to the timeline.`
  }

  return `You are a helpful trip planning assistant for the trip "${trip.name}".

TRIP DETAILS:
- Destination: ${trip.location}
- Dates: ${trip.start_date} to ${trip.end_date}
- Status: ${trip.status}

PARTICIPANTS:
${participantList}

PLANNING SECTIONS:
${sectionSummary}

CURRENT TIMELINE:
${eventSummary}

EXPENSES: ${expenseSummary}

${roleInstructions}

IMPORTANT: This is a SHARED chat. All participants can see all messages and your responses. Be helpful and informative to everyone.

Respond with JSON only: { "message": "your response text", "actions": [...] }
The "message" field is always shown to all participants. Keep it friendly and clear.
If no actions needed, omit the "actions" field or use an empty array.
Do NOT wrap the JSON in markdown code blocks.`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Missing authorization header')
    }

    // User-scoped client for auth checks
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    // Service role client for inserting chat messages and timeline events
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Verify user
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      throw new Error('Unauthorized')
    }

    const { tripId, message } = await req.json()
    if (!tripId || !message) {
      throw new Error('Missing tripId or message')
    }

    // Verify trip participant
    const { data: isParticipant } = await supabaseClient.rpc('is_trip_participant', {
      p_trip_id: tripId,
      p_user_id: user.id,
    })
    if (!isParticipant) {
      throw new Error('User is not a participant in this trip')
    }

    // Check organizer status
    const { data: isOrganizer } = await supabaseClient.rpc('is_trip_organizer', {
      p_trip_id: tripId,
      p_user_id: user.id,
    })

    // Get user name
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('full_name, email')
      .eq('id', user.id)
      .single()
    const userName = userData?.full_name || userData?.email || 'Unknown'

    // Gather trip context
    const [tripResult, participantsResult, sectionsResult, expensesResult, eventsResult, chatResult] = await Promise.all([
      supabaseAdmin.from('trips').select('*').eq('id', tripId).single(),
      supabaseAdmin.from('trip_participants').select('*, user:user_id(full_name, email, avatar_data)').eq('trip_id', tripId).eq('active', true),
      supabaseAdmin.from('planning_sections').select('*, options(*, selections(user_id))').eq('trip_id', tripId).order('order_index'),
      supabaseAdmin.from('expenses').select('amount, currency, description').eq('trip_id', tripId),
      supabaseAdmin.from('trip_timeline_events').select('*').eq('trip_id', tripId).order('event_date').order('start_time'),
      supabaseAdmin.from('trip_chat_messages').select('role, content, user_id, created_at').eq('trip_id', tripId).order('created_at', { ascending: false }).limit(50),
    ])

    const tripContext = {
      trip: tripResult.data,
      participants: participantsResult.data || [],
      sections: sectionsResult.data || [],
      expenses: expensesResult.data || [],
      timelineEvents: eventsResult.data || [],
    }

    // Build conversation history for Claude
    const recentMessages = (chatResult.data || []).reverse()
    const conversationHistory = recentMessages.map((msg: any) => {
      if (msg.role === 'assistant') {
        return { role: 'assistant' as const, content: msg.content }
      }
      // Find user name for context
      const msgUser = (participantsResult.data || []).find((p: any) => p.user_id === msg.user_id)
      const msgUserName = msgUser?.user?.full_name || msgUser?.user?.email || 'Someone'
      return { role: 'user' as const, content: `[${msgUserName}]: ${msg.content}` }
    })

    // Add current message
    conversationHistory.push({
      role: 'user' as const,
      content: `[${userName}]: ${message}`,
    })

    const systemPrompt = buildSystemPrompt(tripContext, !!isOrganizer, userName)

    // Call Claude API
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicApiKey) {
      throw new Error('Anthropic API key not configured')
    }

    // Store user message before calling AI
    await supabaseAdmin.from('trip_chat_messages').insert({
      trip_id: tripId,
      user_id: user.id,
      role: 'user',
      content: message,
    })

    // Call Claude API with streaming + prompt caching
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        stream: true,
        // Prompt caching: cache the system prompt (trip context) so repeated
        // messages in the same trip don't re-process all context tokens
        cache_control: { type: 'ephemeral' },
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          }
        ],
        messages: conversationHistory,
      }),
    })

    if (!claudeResponse.ok) {
      const errorText = await claudeResponse.text()
      console.error('Claude API error:', claudeResponse.status, errorText)
      throw new Error(`AI service error (${claudeResponse.status})`)
    }

    // Stream the response to the client as SSE
    const reader = claudeResponse.body!.getReader()
    const decoder = new TextDecoder()
    let fullText = ''

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()

        try {
          let buffer = ''
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim()
                if (data === '[DONE]') continue

                try {
                  const event = JSON.parse(data)

                  if (event.type === 'content_block_delta' && event.delta?.text) {
                    fullText += event.delta.text
                    // Forward the text chunk to the client
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', text: event.delta.text })}\n\n`))
                  }
                } catch {
                  // Skip unparseable SSE events
                }
              }
            }
          }

          // Parse the complete response for actions
          let parsed: LLMResponse
          try {
            let jsonContent = fullText.trim()
            // Strip markdown code fences if present
            if (jsonContent.startsWith('```json')) {
              jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '')
            } else if (jsonContent.startsWith('```')) {
              jsonContent = jsonContent.replace(/```\n?/g, '')
            }
            parsed = JSON.parse(jsonContent)
          } catch {
            // LLM sometimes outputs natural language BEFORE the JSON object.
            // Try to find and extract the JSON from the text.
            let extracted = false
            for (const pattern of ['{ "message"', '{"message"']) {
              const idx = fullText.indexOf(pattern)
              if (idx !== -1) {
                try {
                  parsed = JSON.parse(fullText.slice(idx))
                  extracted = true
                  break
                } catch {
                  // Try trimming trailing text after the JSON by finding balanced braces
                  const jsonCandidate = fullText.slice(idx)
                  let depth = 0
                  let end = -1
                  for (let i = 0; i < jsonCandidate.length; i++) {
                    if (jsonCandidate[i] === '{') depth++
                    else if (jsonCandidate[i] === '}') {
                      depth--
                      if (depth === 0) { end = i + 1; break }
                    }
                  }
                  if (end !== -1) {
                    try {
                      parsed = JSON.parse(jsonCandidate.slice(0, end))
                      extracted = true
                      break
                    } catch { /* continue */ }
                  }
                }
              }
            }
            if (!extracted) {
              parsed = { message: fullText, actions: [] }
            }
          }

          // CRITICAL: Strip actions for non-organizers
          if (!isOrganizer) {
            parsed.actions = []
          }

          // Execute actions if organizer
          const executedActions: TimelineAction[] = []
          if (isOrganizer && parsed.actions && parsed.actions.length > 0) {
            for (const action of parsed.actions) {
              try {
                if (action.type === 'create_event') {
                  const { error } = await supabaseAdmin.from('trip_timeline_events').insert({
                    trip_id: tripId,
                    event_date: action.event_date!,
                    start_time: action.start_time || null,
                    end_time: action.end_time || null,
                    all_day: action.all_day || false,
                    title: action.title || action.event_title || 'Untitled',
                    description: action.description || null,
                    category: action.category || 'other',
                    location: action.location || null,
                    created_by: user.id,
                  })
                  if (!error) {
                    executedActions.push({ ...action, event_title: action.title || action.event_title })
                  } else {
                    console.error('Error creating event:', error)
                  }
                } else if (action.type === 'update_event' && action.event_id) {
                  const updateData: Record<string, any> = { updated_at: new Date().toISOString() }
                  if (action.title) updateData.title = action.title
                  if (action.description !== undefined) updateData.description = action.description
                  if (action.event_date) updateData.event_date = action.event_date
                  if (action.start_time !== undefined) updateData.start_time = action.start_time
                  if (action.end_time !== undefined) updateData.end_time = action.end_time
                  if (action.category) updateData.category = action.category
                  if (action.location !== undefined) updateData.location = action.location
                  if (action.all_day !== undefined) updateData.all_day = action.all_day

                  const { error } = await supabaseAdmin
                    .from('trip_timeline_events')
                    .update(updateData)
                    .eq('id', action.event_id)
                    .eq('trip_id', tripId)
                  if (!error) executedActions.push(action)
                  else console.error('Error updating event:', error)
                } else if (action.type === 'delete_event' && action.event_id) {
                  const { error } = await supabaseAdmin
                    .from('trip_timeline_events')
                    .delete()
                    .eq('id', action.event_id)
                    .eq('trip_id', tripId)
                  if (!error) executedActions.push(action)
                  else console.error('Error deleting event:', error)
                }
              } catch (actionError) {
                console.error('Error executing action:', actionError)
              }
            }
          }

          // Store assistant response
          await supabaseAdmin.from('trip_chat_messages').insert({
            trip_id: tripId,
            user_id: null,
            role: 'assistant',
            content: parsed.message,
            actions_executed: executedActions,
            had_write_actions: executedActions.length > 0,
          })

          // Send final event with actions summary
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', message: parsed.message, actions_summary: executedActions })}\n\n`))
          controller.close()
        } catch (streamError) {
          console.error('Stream error:', streamError)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: 'Stream interrupted' })}\n\n`))
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })

  } catch (error) {
    console.error('Trip chat error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Chat request failed',
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
