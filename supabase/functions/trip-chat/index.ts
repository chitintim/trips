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
  const { trip, participants, sections, timelineEvents, balances, pendingClaims, expenseOverview } = tripContext

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

  // Timeline events now include IDs so the AI can reference them for update/delete
  const eventSummary = timelineEvents.length > 0
    ? timelineEvents
      .map((e: any) => `- [${e.id}] ${e.event_date} ${e.start_time || 'all day'}: ${e.title} [${e.category}]${e.location ? ` @ ${e.location}` : ''}${e.description ? ` — ${e.description.slice(0, 100)}` : ''}`)
      .join('\n')
    : '(no events yet)'

  // Expense balances per user
  const balanceSummary = balances.length > 0
    ? balances
      .map((b: any) => {
        const name = nameMap[b.userId] || 'Unknown'
        if (b.netBalance > 0.01) return `- ${name}: is owed ${b.currency}${b.netBalance.toFixed(2)} (paid ${b.currency}${b.totalPaid.toFixed(2)}, owes ${b.currency}${b.totalOwed.toFixed(2)})`
        if (b.netBalance < -0.01) return `- ${name}: owes ${b.currency}${Math.abs(b.netBalance).toFixed(2)} (paid ${b.currency}${b.totalPaid.toFixed(2)}, owes ${b.currency}${b.totalOwed.toFixed(2)})`
        return `- ${name}: settled up`
      })
      .join('\n')
    : '(no expenses yet)'

  // Pending claims for itemized expenses
  const claimsSummary = pendingClaims.length > 0
    ? pendingClaims
      .map((c: any) => {
        const missingNames = c.missingUsers.map((uid: string) => nameMap[uid] || 'Unknown').join(', ')
        return `- "${c.description}" (${c.currency}${c.amount}) — ${c.status}${c.claimCode ? ` — claim code: ${c.claimCode}` : ''}\n  Awaiting claims from: ${missingNames || 'everyone'}`
      })
      .join('\n')
    : null

  // Expense overview
  const expenseText = expenseOverview.totalCount > 0
    ? `${expenseOverview.totalCount} expenses. ${expenseOverview.byCurrency.map((c: any) => `${c.currency}${c.total.toFixed(2)}`).join(', ')}.${expenseOverview.byCategory.length > 0 ? ` Categories: ${expenseOverview.byCategory.map((c: any) => `${c.category} (${c.count})`).join(', ')}.` : ''}`
    : '(no expenses yet)'

  let roleInstructions: string
  if (isOrganizer) {
    roleInstructions = `The current user "${userName}" is an ORGANIZER. They can ask you to create, update, or delete timeline events.

When they ask to add/create events, return actions in the "actions" array. Each action should be:
- type: "create_event" — include event_date (YYYY-MM-DD), title, category, and optionally start_time (HH:MM), end_time, description, location, all_day
- type: "update_event" — include event_id (UUID from the timeline above) and fields to change
- type: "delete_event" — include event_id (UUID from the timeline above)

Valid categories: flight, accommodation, transport, activity, dining, transfer, meeting_point, free_time, other

You can create multiple events in a single response (e.g., when importing a full itinerary).
Always include event_title in each action for display purposes.`
  } else {
    roleInstructions = `The current user "${userName}" is a PARTICIPANT (not an organizer). They can ask questions about the trip, but you MUST NOT return any actions. Do NOT include an "actions" array in your response. If they ask to change something, politely tell them only organizers can make changes to the timeline.`
  }

  let expenseSection = `EXPENSES OVERVIEW: ${expenseText}

BALANCES:
${balanceSummary}`

  if (claimsSummary) {
    expenseSection += `

PENDING ITEMIZED CLAIMS (these expenses need participants to select what they consumed):
${claimsSummary}`
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

${expenseSection}

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

    // Rate limiting & message length limits
    const MAX_MESSAGES_ORGANIZER = 20
    const MAX_MESSAGES_PARTICIPANT = 5
    const MAX_LENGTH_ORGANIZER = 10000   // ~2000 words, enough for pasting booking details
    const MAX_LENGTH_PARTICIPANT = 700   // ~100 words

    const maxLength = isOrganizer ? MAX_LENGTH_ORGANIZER : MAX_LENGTH_PARTICIPANT
    if (message.length > maxLength) {
      throw new Error(
        isOrganizer
          ? `Message too long (${message.length} chars). Maximum is ${MAX_LENGTH_ORGANIZER} characters.`
          : `Message too long. Please keep messages under ${MAX_LENGTH_PARTICIPANT} characters (~100 words).`
      )
    }

    const maxMessages = isOrganizer ? MAX_MESSAGES_ORGANIZER : MAX_MESSAGES_PARTICIPANT
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const { count: todayCount } = await supabaseAdmin
      .from('trip_chat_messages')
      .select('*', { count: 'exact', head: true })
      .eq('trip_id', tripId)
      .eq('user_id', user.id)
      .eq('role', 'user')
      .gte('created_at', todayStart.toISOString())
    if ((todayCount ?? 0) >= maxMessages) {
      throw new Error(
        `You've reached your daily limit of ${maxMessages} messages. Try again tomorrow.`
      )
    }

    // Get user name
    const { data: userData } = await supabaseAdmin
      .from('users')
      .select('full_name, email')
      .eq('id', user.id)
      .single()
    const userName = userData?.full_name || userData?.email || 'Unknown'

    // Gather trip context — expenses use nested selects for splits, claims, and allocation links
    const [tripResult, participantsResult, sectionsResult, expensesResult, settlementsResult, eventsResult, chatResult] = await Promise.all([
      supabaseAdmin.from('trips').select('*').eq('id', tripId).single(),
      supabaseAdmin.from('trip_participants').select('*, user:user_id(full_name, email, avatar_data)').eq('trip_id', tripId).eq('active', true),
      supabaseAdmin.from('planning_sections').select('*, options(*, selections(user_id))').eq('trip_id', tripId).order('order_index'),
      supabaseAdmin.from('expenses').select('id, paid_by, amount, currency, base_currency_amount, description, category, status, ai_parsed, fx_rate, expense_splits(user_id, amount, base_currency_amount), expense_item_claims(user_id, amount_owed), expense_allocation_links(code)').eq('trip_id', tripId),
      supabaseAdmin.from('settlements').select('from_user_id, to_user_id, amount').eq('trip_id', tripId),
      supabaseAdmin.from('trip_timeline_events').select('*').eq('trip_id', tripId).order('event_date').order('start_time'),
      supabaseAdmin.from('trip_chat_messages').select('role, content, user_id, created_at').eq('trip_id', tripId).order('created_at', { ascending: false }).limit(50),
    ])

    const expenses = expensesResult.data || []
    const participants = participantsResult.data || []
    const participantIds = participants.map((p: any) => p.user_id)
    const settlements = settlementsResult.data || []

    // Extract nested data from expenses
    const splits = expenses.flatMap((e: any) => (e.expense_splits || []).map((s: any) => ({ ...s, expense_id: e.id })))
    const claims = expenses.flatMap((e: any) => (e.expense_item_claims || []).map((c: any) => ({ ...c, expense_id: e.id })))
    const allocationLinks = expenses.flatMap((e: any) => (e.expense_allocation_links || []).map((l: any) => ({ ...l, expense_id: e.id })))

    // Compute per-user balances (mirrors frontend debtMinimization logic)
    // Use base_currency_amount (GBP) when available, otherwise original amount
    const baseCurrency = 'GBP'
    const balances: Array<{ userId: string, totalPaid: number, totalOwed: number, netBalance: number, currency: string }> = []

    for (const pid of participantIds) {
      // Total paid by this user
      const totalPaid = expenses
        .filter((e: any) => e.paid_by === pid)
        .reduce((sum: number, e: any) => sum + Number(e.base_currency_amount || e.amount), 0)

      // Total owed from splits (non-itemized expenses)
      const totalOwedSplits = splits
        .filter((s: any) => s.user_id === pid)
        .reduce((sum: number, s: any) => sum + Number(s.base_currency_amount || s.amount), 0)

      // Total owed from claims (itemized expenses)
      const totalOwedClaims = claims
        .filter((c: any) => c.user_id === pid)
        .reduce((sum: number, c: any) => {
          const expense = expenses.find((e: any) => e.id === c.expense_id)
          const fxRate = expense?.fx_rate ? Number(expense.fx_rate) : 1
          return sum + Number(c.amount_owed) * fxRate
        }, 0)

      const totalOwed = totalOwedSplits + totalOwedClaims

      // Settlements
      const settledPaid = settlements
        .filter((s: any) => s.from_user_id === pid)
        .reduce((sum: number, s: any) => sum + Number(s.amount), 0)
      const settledReceived = settlements
        .filter((s: any) => s.to_user_id === pid)
        .reduce((sum: number, s: any) => sum + Number(s.amount), 0)

      const netBalance = totalPaid - totalOwed + settledPaid - settledReceived

      balances.push({ userId: pid, totalPaid, totalOwed, netBalance, currency: baseCurrency })
    }

    // Identify pending itemized claims (expenses needing user action)
    const pendingClaims: Array<{ description: string, amount: number, currency: string, status: string, claimCode: string | null, missingUsers: string[] }> = []
    const pendingExpenses = expenses.filter((e: any) => e.ai_parsed && e.status && ['unallocated', 'pending_allocation'].includes(e.status))

    for (const expense of pendingExpenses) {
      const expenseClaims = claims.filter((c: any) => c.expense_id === expense.id)
      const claimedUserIds = [...new Set(expenseClaims.map((c: any) => c.user_id))]
      // Everyone except the payer should claim
      const missingUsers = participantIds.filter((pid: string) => pid !== expense.paid_by && !claimedUserIds.includes(pid))
      const link = allocationLinks.find((l: any) => l.expense_id === expense.id)

      pendingClaims.push({
        description: expense.description,
        amount: Number(expense.amount),
        currency: expense.currency || baseCurrency,
        status: expense.status,
        claimCode: link?.code || null,
        missingUsers,
      })
    }

    // Expense overview (totals by currency and category)
    const byCurrency: Record<string, number> = {}
    const byCategory: Record<string, number> = {}
    for (const e of expenses) {
      const curr = e.currency || baseCurrency
      byCurrency[curr] = (byCurrency[curr] || 0) + Number(e.amount)
      byCategory[e.category] = (byCategory[e.category] || 0) + 1
    }

    const tripContext = {
      trip: tripResult.data,
      participants,
      sections: sectionsResult.data || [],
      timelineEvents: eventsResult.data || [],
      balances,
      pendingClaims,
      expenseOverview: {
        totalCount: expenses.length,
        byCurrency: Object.entries(byCurrency).map(([currency, total]) => ({ currency, total })),
        byCategory: Object.entries(byCategory).map(([category, count]) => ({ category, count })),
      },
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
