// Receipt Parsing Edge Function v2 (plan §10)
//
// REWRITE, but keeps the existing request/response envelope fields the
// current frontend sends/expects (src/lib/receiptParsing.ts) so the live
// app keeps working until cutover -- new v2 fields are ADDED alongside the
// legacy flat fields inside `data`, never replacing them.
//
// Model: claude-sonnet-5, structured outputs against ReceiptParseResult.
// Then the adjustment disambiguation engine (pure TS, not the model) in
// _shared/receiptReconciliation.ts verifies Σ(lines)=subtotal and
// subtotal±adjustments=total in integer minor units; on mismatch, hypothesis-
// tests standard interpretations and selects the one that reconciles exactly.
// One repair re-prompt if nothing reconciles; still failing -> printed-total-
// trusted result with per-line review flags. Never silently adjusts.
//
// Rate limit: 20 parses/day/user (plan §10).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { handleCorsPreflight } from '../_shared/cors.ts'
import { errorResponse, jsonResponse } from '../_shared/errors.ts'
import { callerClient, requireUser, requireTripParticipant } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { createMessage, padForCaching, CLAUDE_MODEL, type AnthropicContentBlock } from '../_shared/anthropic.ts'
import { logAiUsage } from '../_shared/usage.ts'
import { reconcileReceipt, buildRepairPrompt, type ReconciliationResult } from '../_shared/receiptReconciliation.ts'
import { ReceiptParseResultSchema, ReceiptParseResultJsonSchema, type ReceiptParseResult } from '../_shared/contracts/receiptParseResult.ts'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB, matches existing bucket cap

const SYSTEM_PROMPT_STATIC = `You are an expert receipt-parsing assistant. You will be shown an image (or PDF) of a purchase receipt and must extract every piece of structured information from it, precisely, into the ReceiptParseResult JSON schema you have been given as your required output format.

CORE PRINCIPLES

1. Extract EVERY line item visible on the receipt. Do not summarize or omit items, including small ones (side dishes, garnishes, single drinks). \`line_items\` must NEVER be an empty array if the image shows a purchase receipt at all -- if you can read a vendor name or a total, there is at least one line item to extract, even if you can only make out a partial description for it (use your best reading and lower \`confidence\` rather than dropping the line). Only omit line items entirely for a document that isn't a line-itemized receipt at all (e.g. a bank transfer confirmation with no purchased items).
2. For each line item, determine whether the printed number next to the quantity is a UNIT PRICE or a LINE TOTAL, and record which in \`printed_field\`:
   - If a receipt shows "2x ¥900" and the line reads ¥1800, the printed number is more likely the line total already reflecting quantity -- but you must reason from context. Cross-check: if summing the numbers-as-shown for all lines gets you close to the printed subtotal, they are line totals; if summing (quantity * number-as-shown) gets you close to the printed subtotal, they are unit prices.
   - If you cannot tell with confidence, set printed_field to "ambiguous" rather than guessing.
   - If both a unit price AND a line total are printed and they agree (unit_price * quantity == line_total), set printed_field to "both".
3. Translate non-English item names into \`name_english\` while preserving \`name_original\` exactly as printed (including diacritics/non-Latin scripts).
4. Extract EVERY tax line as a separate entry in the \`tax\` array with its rate (as a decimal, e.g. 0.08 for 8%) and whether it is already included in the displayed prices (\`inclusive: true\`) or an additional charge on top (\`inclusive: false\`). Japanese receipts often show a dual 8%/10% breakdown (8%対象／10%対象) -- these are informational breakdowns of tax ALREADY INCLUDED in the displayed prices; set inclusive: true for each. European VAT/TVA/MwSt/IVA lines are almost always inclusive: true (prices already include VAT by law). US sales tax and similar add-on taxes are inclusive: false.
5. Extract the service charge (if any) as a single object noting whether it is automatic/mandatory (\`auto: true\`) or a voluntary suggestion (\`auto: false\`), and its amount or percent as printed.
6. Extract any discounts (loyalty, voucher, promotional) at the receipt level in \`discounts\`, and any item-specific discounts nested under that line item's \`discounts\`.
7. Extract a \`rounding_adjustment\` if the receipt shows cash-rounding (common in countries without 1-cent/1-yen coins in circulation, or JPY consumption-tax rounding).
8. Record your confidence (0-1) for uncertain fields in the \`confidence\` array, and use \`notes\` for anything unusual you noticed.
9. Do NOT perform any arithmetic reconciliation yourself, and do NOT adjust any number you read from the receipt to make totals match -- report exactly what is printed, even if it looks internally inconsistent. A separate verification pass handles reconciliation.
10. The currency must be a 3-letter ISO 4217 code inferred from symbols/context (¥ + Japanese text -> JPY, € -> EUR, £ -> GBP, $ + US context -> USD, etc).
11. \`receipt_date\` must be YYYY-MM-DD, or null if no date is visible.
12. If the receipt is a PDF (e.g. an emailed invoice), read it the same way as an image.

Return ONLY the structured ReceiptParseResult -- no prose commentary outside the schema.`

interface LegacyLineItem {
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

interface LegacyReceiptData {
  vendor_name: string
  vendor_location?: string
  receipt_date?: string
  currency: string
  expense_category: string
  vat_inclusive: boolean
  subtotal: number
  total: number
  tax_percent?: number
  tax_amount?: number
  service_charge_percent?: number
  service_charge_amount?: number
  discount_amount?: number
  discount_percent?: number
  line_items: LegacyLineItem[]
  total_matches: boolean
  calculation_notes?: string
  // v2 additions (extend, don't break -- old frontend ignores unknown fields)
  v2: {
    receipt: ReceiptParseResult
    reconciliation: ReconciliationResult
  }
}

/** Guesses an expense_category from vendor name / line items -- best-effort heuristic, matches v1 categories. */
function guessExpenseCategory(receipt: ReceiptParseResult): string {
  const text = [receipt.vendor_name, ...receipt.line_items.map((l) => l.name_english || l.name_original)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (/hotel|hostel|airbnb|lodge|apartment|room/.test(text)) return 'accommodation'
  if (/taxi|train|bus|flight|airline|parking|fuel|car rental|transfer|uber|metro/.test(text)) return 'transport'
  if (/ski|lift|pass|tour|museum|attraction|lesson|entrance|activity/.test(text)) return 'activities'
  if (/rental|gear|equipment|helmet|boots/.test(text)) return 'equipment'
  if (/restaurant|cafe|bar|food|grocery|bakery|pizza|ramen|izakaya|conbini|supermarket/.test(text)) return 'food'
  return 'food' // default bias: receipts are usually food/dining
}

/** Maps the v2 ReceiptParseResult + reconciliation result into the legacy flat shape the current frontend expects. */
function toLegacyShape(receipt: ReceiptParseResult, reconciliation: ReconciliationResult): LegacyReceiptData {
  const isZeroDecimal = receipt.currency === 'JPY' || receipt.currency === 'KRW'
  const inclusiveTax = receipt.tax.filter((t) => t.inclusive)
  const exclusiveTax = receipt.tax.filter((t) => !t.inclusive)
  const vatInclusive = inclusiveTax.length > 0 && exclusiveTax.length === 0

  const totalExclusiveTax = exclusiveTax.reduce((sum, t) => sum + t.amount, 0)
  const totalExclusiveTaxRate = exclusiveTax.length > 0 && exclusiveTax[0].rate != null ? exclusiveTax[0].rate : undefined

  const lineItemsTotal = receipt.line_items.length > 0
    ? receipt.line_items.reduce((sum, l) => sum + l.line_total, 0)
    : 0

  const legacyLineItems: LegacyLineItem[] = receipt.line_items.map((l) => {
    const lineDiscountAmount = l.discounts.reduce((s, d) => s + (d.amount ?? 0), 0) || undefined
    const lineDiscountPercent = l.discounts.find((d) => d.percent != null)?.percent ?? undefined
    // Proportional share of tax/service, matching v1's distribution convention.
    const share = lineItemsTotal > 0 ? l.line_total / lineItemsTotal : 0
    const taxAmount = vatInclusive ? 0 : totalExclusiveTax * share
    const serviceAmount = receipt.service_charge?.amount
      ? receipt.service_charge.amount * share
      : receipt.service_charge?.percent
        ? (l.line_total * receipt.service_charge.percent) / 100
        : 0
    return {
      line_number: l.line_number,
      name_original: l.name_original,
      name_english: l.name_english ?? undefined,
      quantity: l.quantity,
      unit_price: l.unit_price,
      line_discount_amount: lineDiscountAmount,
      line_discount_percent: lineDiscountPercent,
      subtotal: l.line_total,
      tax_amount: isZeroDecimal ? Math.round(taxAmount) : Math.round(taxAmount * 100) / 100,
      service_amount: isZeroDecimal ? Math.round(serviceAmount) : Math.round(serviceAmount * 100) / 100,
      total_amount: isZeroDecimal
        ? Math.round(l.line_total + taxAmount + serviceAmount)
        : Math.round((l.line_total + taxAmount + serviceAmount) * 100) / 100,
    }
  })

  return {
    vendor_name: receipt.vendor_name ?? 'Unknown vendor',
    vendor_location: receipt.vendor_address ?? undefined,
    receipt_date: receipt.receipt_date ?? undefined,
    currency: receipt.currency,
    expense_category: guessExpenseCategory(receipt),
    vat_inclusive: vatInclusive,
    subtotal: receipt.subtotal ?? lineItemsTotal,
    total: receipt.total,
    tax_percent: totalExclusiveTaxRate != null ? totalExclusiveTaxRate * 100 : (vatInclusive ? 0 : undefined),
    tax_amount: vatInclusive ? 0 : totalExclusiveTax,
    service_charge_percent: receipt.service_charge?.percent ?? undefined,
    service_charge_amount: receipt.service_charge?.amount ?? undefined,
    discount_amount: receipt.discounts.reduce((s, d) => s + (d.amount ?? 0), 0) || undefined,
    discount_percent: receipt.discounts.find((d) => d.percent != null)?.percent ?? undefined,
    line_items: legacyLineItems,
    total_matches: reconciliation.reconciled,
    calculation_notes: reconciliation.reconciled
      ? receipt.notes ?? undefined
      : `${reconciliation.explanation}${receipt.notes ? ` ${receipt.notes}` : ''}`,
    v2: { receipt, reconciliation },
  }
}

async function callClaudeForReceipt(
  fileBlock: AnthropicContentBlock,
  repairContext?: { previousReceipt: ReceiptParseResult; repairPrompt: string }
) {
  const messages = repairContext
    ? [
        {
          role: 'user' as const,
          content: [fileBlock, { type: 'text' as const, text: 'Extract this receipt into the ReceiptParseResult schema.' }],
        },
        {
          role: 'assistant' as const,
          content: JSON.stringify(repairContext.previousReceipt),
        },
        {
          role: 'user' as const,
          content: repairContext.repairPrompt,
        },
      ]
    : [
        {
          role: 'user' as const,
          content: [fileBlock, { type: 'text' as const, text: 'Extract this receipt into the ReceiptParseResult schema.' }],
        },
      ]

  return await createMessage({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: padForCaching(SYSTEM_PROMPT_STATIC),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
    output_config: {
      // Extraction, not deliberation: low effort curbs Sonnet 5's default
      // adaptive thinking (on when 'thinking' is omitted) for fast parses.
      effort: 'low',
      format: { type: 'json_schema', schema: ReceiptParseResultJsonSchema.schema},
    },
  })
}

function extractJsonFromResponse(content: AnthropicContentBlock[]): unknown {
  const textBlock = content.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
  if (!textBlock?.text) {
    throw new Error('No text content in Claude response')
  }
  return JSON.parse(textBlock.text)
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  let tripId: string | null = null

  try {
    const supabaseClient = callerClient(req)
    const user = await requireUser(supabaseClient)

    const { receiptPath, tripId: bodyTripId } = await req.json()
    if (!receiptPath || !bodyTripId) {
      throw new Error('Missing receiptPath or tripId')
    }
    const currentTripId: string = bodyTripId
    tripId = currentTripId

    await requireTripParticipant(supabaseClient, currentTripId, user.id)

    await consumeRateLimit(supabaseClient, RATE_LIMITS.parseReceipt)

    // Download receipt from storage (via caller's client so RLS/storage policy applies)
    const { data: imageData, error: downloadError } = await supabaseClient
      .storage
      .from('receipts')
      .download(receiptPath)

    if (downloadError || !imageData) {
      throw new Error(`Failed to download receipt from path "${receiptPath}": ${downloadError?.message ?? 'no data'}`)
    }

    if (imageData.size > MAX_FILE_SIZE) {
      throw new Error('Image too large. Maximum 5MB allowed.')
    }

    let mimeType = imageData.type || 'image/jpeg'
    if (!mimeType || mimeType === 'application/octet-stream') {
      const ext = receiptPath.toLowerCase().split('.').pop()
      const mimeTypes: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
      }
      mimeType = mimeTypes[ext || ''] || 'image/jpeg'
    }

    const arrayBuffer = await imageData.arrayBuffer()
    const uint8Array = new Uint8Array(arrayBuffer)
    let binaryString = ''
    const chunkSize = 8192
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      binaryString += String.fromCharCode(...uint8Array.subarray(i, i + chunkSize))
    }
    const base64 = btoa(binaryString)

    const isPdf = mimeType === 'application/pdf'
    const fileBlock: AnthropicContentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }

    // --- First pass ---
    const response = await callClaudeForReceipt(fileBlock)
    let totalUsage = { ...response.usage }
    let parsed = ReceiptParseResultSchema.parse(extractJsonFromResponse(response.content))
    let reconciliation = reconcileReceipt(parsed)

    // --- One repair re-prompt if nothing reconciled ---
    if (!reconciliation.reconciled) {
      const repairPrompt = buildRepairPrompt(parsed, reconciliation)
      try {
        const repairResponse = await callClaudeForReceipt(fileBlock, { previousReceipt: parsed, repairPrompt })
        totalUsage = {
          input_tokens: totalUsage.input_tokens + repairResponse.usage.input_tokens,
          output_tokens: totalUsage.output_tokens + repairResponse.usage.output_tokens,
          cache_creation_input_tokens: (totalUsage.cache_creation_input_tokens ?? 0) + (repairResponse.usage.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens: (totalUsage.cache_read_input_tokens ?? 0) + (repairResponse.usage.cache_read_input_tokens ?? 0),
        }
        const repairedParsed = ReceiptParseResultSchema.parse(extractJsonFromResponse(repairResponse.content))
        const repairedReconciliation = reconcileReceipt(repairedParsed)
        // Only adopt the repair if it actually reconciles -- otherwise keep
        // the original extraction (still printed-total-trusted either way).
        if (repairedReconciliation.reconciled) {
          parsed = repairedParsed
          reconciliation = repairedReconciliation
        }
      } catch (repairError) {
        console.error('[parse-receipt] repair re-prompt failed:', repairError)
        // fall through with original (unreconciled) parse
      }
    }

    await logAiUsage({ userId: user.id, tripId, functionName: 'parse-receipt', model: response.model, usage: totalUsage })

    const legacyData = toLegacyShape(parsed, reconciliation)

    return jsonResponse({ success: true, data: legacyData })
  } catch (error) {
    return errorResponse(error)
  }
})

/* To invoke locally:

  1. supabase start
  2. supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
  3. supabase functions serve parse-receipt
  4. curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/parse-receipt' \
       --header 'Authorization: Bearer YOUR_SUPABASE_ANON_KEY' \
       --header 'Content-Type: application/json' \
       --data '{"receiptPath":"userId/receipt.jpg","tripId":"trip-uuid"}'

*/
