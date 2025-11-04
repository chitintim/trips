// Receipt Parsing Edge Function with OpenAI GPT-4o Vision
// This function extracts structured data from receipt images and PDFs

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

// CORS headers for requests from GitHub Pages
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Type definitions
interface ReceiptLineItem {
  line_number: number
  name_original: string
  name_english?: string
  quantity: number
  unit_price: number
  line_discount_amount?: number
  line_discount_percent?: number
  subtotal: number
  tax_amount: number
  service_amount: number
  total_amount: number
}

interface ReceiptData {
  vendor_name: string
  vendor_location?: string
  receipt_date?: string
  currency: string
  expense_category: string // 'accommodation' | 'transport' | 'food' | 'activities' | 'equipment' | 'other'
  subtotal: number
  total: number
  tax_percent?: number
  tax_amount?: number
  service_charge_percent?: number
  service_charge_amount?: number
  discount_amount?: number
  discount_percent?: number
  line_items: ReceiptLineItem[]
  total_matches: boolean
  calculation_notes?: string
}

// OpenAI prompt for receipt parsing
function getReceiptParsingPrompt(): string {
  return `You are a receipt parsing expert. Analyze this receipt image and extract ALL information in a structured JSON format.

CRITICAL REQUIREMENTS:
1. Extract EVERY line item visible on the receipt
2. Translate foreign language items to English (keep original too)
3. Calculate individual line item taxes and service charges proportionally
4. Ensure line items SUM EXACTLY to the grand total
5. Identify the calculation order: typically (subtotal - discount) + tax + service = total
6. Categorize the expense based on vendor and items

Return JSON in this EXACT structure:
{
  "vendor_name": "Restaurant Name",
  "vendor_location": "City, Country (if visible)",
  "receipt_date": "YYYY-MM-DD (if visible)",
  "currency": "GBP" or "EUR" etc,
  "expense_category": "food",

  "subtotal": 100.00,
  "total": 115.00,

  "tax_percent": 10.0,
  "tax_amount": 10.00,
  "service_charge_percent": 5.0,
  "service_charge_amount": 5.00,
  "discount_amount": 0.00,
  "discount_percent": 0.0,

  "line_items": [
    {
      "line_number": 1,
      "name_original": "Margherita Pizza",
      "name_english": "Margherita Pizza",
      "quantity": 2,
      "unit_price": 12.50,
      "line_discount_amount": 0.00,
      "line_discount_percent": 0.0,
      "subtotal": 25.00,
      "tax_amount": 2.50,
      "service_amount": 1.25,
      "total_amount": 28.75
    }
  ],

  "total_matches": true,
  "calculation_notes": "Any notes about calculations"
}

EXPENSE CATEGORY RULES:
Choose ONE of these categories based on the vendor and line items:
- "food": Restaurants, cafes, bars, grocery stores, dining, food delivery
- "accommodation": Hotels, hostels, Airbnb, apartments, lodges, room bookings
- "transport": Taxis, trains, buses, flights, parking, fuel, car rental, transfers
- "activities": Ski passes, lift tickets, tours, museums, attractions, lessons, entertainment
- "equipment": Ski rental, gear hire, sports equipment, helmet, boots
- "other": Anything that doesn't fit the above categories

CALCULATION RULES:
- line_item.subtotal = quantity * unit_price - line_discount_amount
- Distribute tax proportionally: line_tax = (line_subtotal / receipt_subtotal) * total_tax
- Distribute service proportionally: line_service = (line_subtotal / receipt_subtotal) * total_service
- line_item.total_amount = subtotal + tax_amount + service_amount
- SUM(all line_item.total_amount) MUST equal receipt total

If receipt is unclear or text is cut off, make best effort estimates and note in calculation_notes.
Return ONLY valid JSON, no markdown formatting.`
}

// Main handler
Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log('Parse-receipt function called')

    // Verify authentication header
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      throw new Error('Missing authorization header')
    }

    // Create Supabase client with user's auth token
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader }
        }
      }
    )

    // Verify user is authenticated
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser()
    if (userError || !user) {
      console.error('Auth error:', userError)
      throw new Error('Unauthorized')
    }

    console.log('User authenticated:', user.id)

    // Parse request body
    const { receiptPath, tripId } = await req.json()
    if (!receiptPath || !tripId) {
      throw new Error('Missing receiptPath or tripId')
    }

    console.log('Receipt path:', receiptPath, 'Trip ID:', tripId)

    // Verify user is trip participant
    const { data: participant, error: participantError } = await supabaseClient
      .from('trip_participants')
      .select('user_id')
      .eq('trip_id', tripId)
      .eq('user_id', user.id)
      .single()

    if (participantError || !participant) {
      console.error('Participant check failed:', participantError)
      throw new Error('User is not a participant in this trip')
    }

    console.log('User verified as trip participant')

    // Download receipt image from Supabase Storage
    // receiptPath format: "userId/filename.jpg"
    console.log('Attempting to download from receipts bucket:', receiptPath)

    const { data: imageData, error: downloadError } = await supabaseClient
      .storage
      .from('receipts')
      .download(receiptPath)

    if (downloadError) {
      console.error('Download error:', downloadError)
      throw new Error(`Failed to download receipt from path "${receiptPath}": ${JSON.stringify(downloadError)}`)
    }

    if (!imageData) {
      throw new Error(`Receipt download returned no data for path: ${receiptPath}`)
    }

    console.log('Receipt downloaded, size:', imageData.size, 'bytes', 'type:', imageData.type)

    // Check file size limit (5MB)
    const maxFileSize = 5 * 1024 * 1024 // 5MB
    if (imageData.size > maxFileSize) {
      throw new Error('Image too large. Maximum 5MB allowed.')
    }

    // Detect MIME type from blob or file extension
    let mimeType = imageData.type || 'image/jpeg'
    if (!mimeType || mimeType === 'application/octet-stream') {
      // Fallback: detect from file extension
      const ext = receiptPath.toLowerCase().split('.').pop()
      const mimeTypes: Record<string, string> = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'pdf': 'application/pdf'
      }
      mimeType = mimeTypes[ext || ''] || 'image/jpeg'
    }

    console.log('Detected MIME type:', mimeType)

    // Convert blob to base64 (process in chunks to avoid stack overflow)
    // Note: OpenAI's gpt-4o-mini supports PDFs directly via base64 encoding (since March 2025)
    // PDFs are passed the same way as images - the API handles both formats
    const arrayBuffer = await imageData.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)

    // Process in chunks to avoid "Maximum call stack size exceeded"
    let binaryString = ''
    const chunkSize = 8192 // 8KB chunks
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize)
      binaryString += String.fromCharCode(...chunk)
    }
    const base64 = btoa(binaryString)

    console.log('Image converted to base64, length:', base64.length)

    // Get OpenAI API key from Supabase secrets
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
    if (!openaiApiKey) {
      throw new Error('OpenAI API key not configured')
    }

    console.log('Calling OpenAI API...')

    // Prepare content based on file type
    // PDFs use "file" type, images use "image_url" type (OpenAI API requirement)
    const isPDF = mimeType === 'application/pdf'
    const fileContent = isPDF ? {
      type: 'file',
      file: {
        filename: receiptPath.split('/').pop() || 'receipt.pdf',
        file_data: `data:${mimeType};base64,${base64}`
      }
    } : {
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${base64}`
      }
    }

    console.log('File type:', isPDF ? 'PDF' : 'Image')

    // Call OpenAI API (using gpt-4o-mini - supports images AND PDFs)
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Supports both images and PDF files (since March 2025)
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: getReceiptParsingPrompt(),
              },
              fileContent, // Different format for PDFs vs images
            ],
          },
        ],
        max_completion_tokens: 8192,
        temperature: 0.1, // Lower temperature for more consistent structured output
      }),
    })

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text()
      console.error('OpenAI API error:', openaiResponse.status, errorText)
      throw new Error(`OpenAI API failed (${openaiResponse.status}): ${errorText}`)
    }

    const openaiData = await openaiResponse.json()
    console.log('OpenAI response received:', JSON.stringify(openaiData, null, 2))

    // Extract content
    const content = openaiData.choices[0]?.message?.content
    if (!content) {
      console.error('Response structure:', JSON.stringify(openaiData, null, 2))
      throw new Error(`No content in OpenAI response. Response structure: ${JSON.stringify(openaiData)}`)
    }

    console.log('Parsing OpenAI response...')

    // Parse JSON response (remove markdown formatting if present)
    let jsonContent = content.trim()
    if (jsonContent.startsWith('```json')) {
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '')
    }

    const parsedData: ReceiptData = JSON.parse(jsonContent)

    // Validate totals
    const calculatedTotal = parsedData.line_items.reduce(
      (sum, item) => sum + item.total_amount,
      0
    )
    const totalDiff = Math.abs(calculatedTotal - parsedData.total)
    parsedData.total_matches = totalDiff < 0.01 // Allow 1 cent difference

    if (!parsedData.total_matches) {
      parsedData.calculation_notes =
        `Warning: Line items sum to ${calculatedTotal.toFixed(2)} but receipt total is ${parsedData.total.toFixed(2)}. ` +
        (parsedData.calculation_notes || '')
    }

    console.log('Receipt parsed successfully:', parsedData.line_items.length, 'items')

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        data: parsedData
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      }
    )

  } catch (error) {
    console.error('Error parsing receipt:', error)

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Failed to parse receipt'
      }),
      {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      }
    )
  }
})

/* To invoke locally:

  1. Start Supabase local development:
     supabase start

  2. Set OpenAI API key:
     supabase secrets set OPENAI_API_KEY=sk-your-key-here

  3. Serve the function:
     supabase functions serve parse-receipt

  4. Test with curl:
     curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/parse-receipt' \
       --header 'Authorization: Bearer YOUR_SUPABASE_ANON_KEY' \
       --header 'Content-Type: application/json' \
       --data '{"receiptPath":"userId/receipt.jpg","tripId":"trip-uuid"}'

*/
