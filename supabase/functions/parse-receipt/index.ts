// Receipt Parsing Edge Function v2 (plan §10)
//
// REWRITE, but keeps the existing request/response envelope fields the
// current frontend sends/expects (src/lib/receiptParsing.ts) so the live
// app keeps working until cutover -- new v2 fields are ADDED alongside the
// legacy flat fields inside `data`, never replacing them.
//
// Model: MODEL_PARSE_RECEIPT (claude-sonnet-5-5 at effort low; env override
// CLAUDE_MODEL_PARSE_RECEIPT), structured outputs against ReceiptParseResult.
// Request + prompt: receiptRequest.ts; first pass + repair: pipeline.ts.
// Then the adjustment disambiguation engine (pure TS, not the model) in
// _shared/receiptReconciliation.ts verifies Σ(lines)=subtotal and
// subtotal±adjustments=total in integer minor units; on mismatch, hypothesis-
// tests standard interpretations and selects the one that reconciles exactly.
// One repair re-prompt if nothing reconciles; still failing -> printed-total-
// trusted result with per-line review flags. Never silently adjusts.
//
// Errors are CODED (see _shared/aiError.ts): { success:false, error, message,
// code } with code unreadable | too_large | unsupported_type | rate_limited |
// busy | refused | unknown. `error` is kept for the current client.
//
// Rate limit: 20 parses/day/user (plan §10). The token is given back (refund_rate_limit
// RPC via the service client, best effort) ONLY when no model call ran; once the API may
// have charged (success or billed failure) it is kept (see refund.ts). Billed failures are
// still written to ai_usage so the monthly breaker counts them.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { handleCorsPreflight } from '../_shared/cors.ts'
import { jsonResponse } from '../_shared/errors.ts'
import { callerClient, serviceClient, requireUser, requireTripParticipant } from '../_shared/supabaseClients.ts'
import { consumeRateLimit, RATE_LIMITS } from '../_shared/rateLimit.ts'
import { type AnthropicContentBlock } from '../_shared/anthropic.ts'
import { logAiUsage, logBilledFailure } from '../_shared/usage.ts'
import { AiCallError, codedErrorResponse } from '../_shared/aiError.ts'
import { type ReconciliationResult } from '../_shared/receiptReconciliation.ts'
import { type ReceiptParseResult } from '../_shared/contracts/receiptParseResult.ts'
import { checkReceiptFile, toBase64 } from './fileType.ts'
import { runReceiptPipeline } from './pipeline.ts'
import { refundIfUnbilled } from './refund.ts'

/** Whole-parse budget (first pass + retry + repair) so we fail cleanly before the edge worker limit. */
const PARSE_BUDGET_MS = 100_000
/** Per model call. */
const CALL_TIMEOUT_MS = 45_000

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

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req)
  if (preflight) return preflight

  let supabaseClient: ReturnType<typeof callerClient> | null = null
  let tokenConsumed = false
  let userId: string | null = null
  let loggedTripId: string | null = null
  let modelRan = false

  try {
    supabaseClient = callerClient(req)
    const user = await requireUser(supabaseClient)
    userId = user.id

    const { receiptPath, tripId } = await req.json()
    if (!receiptPath || !tripId) {
      throw new AiCallError('unknown', 'missing receiptPath or tripId', 'Missing receiptPath or tripId', 400)
    }

    await requireTripParticipant(supabaseClient, tripId, user.id)
    loggedTripId = typeof tripId === 'string' ? tripId : null

    await consumeRateLimit(supabaseClient, RATE_LIMITS.parseReceipt)
    tokenConsumed = true

    // Download receipt from storage (via caller's client so RLS/storage policy applies)
    const { data: fileData, error: downloadError } = await supabaseClient
      .storage
      .from('receipts')
      .download(receiptPath)

    if (downloadError || !fileData) {
      console.error('[parse-receipt] download failed:', downloadError?.message ?? 'no data')
      throw new AiCallError('unknown', 'storage download failed', "We couldn't open the uploaded file. Please try again.", 502)
    }

    const bytes = new Uint8Array(await fileData.arrayBuffer())
    const mediaType = checkReceiptFile(bytes, fileData.type, receiptPath)
    const base64 = toBase64(bytes)

    const fileBlock: AnthropicContentBlock = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }

    const result = await runReceiptPipeline(fileBlock, {
      control: { timeoutMs: CALL_TIMEOUT_MS, deadlineAt: Date.now() + PARSE_BUDGET_MS },
    })

    modelRan = true // the model was billed: from here on the scan token is kept whatever happens
    await logAiUsage({ userId: user.id, tripId, functionName: 'parse-receipt', model: result.model, usage: result.usage })

    return jsonResponse({ success: true, data: toLegacyShape(result.parsed, result.reconciliation) })
  } catch (error) {
    // A call the API charged for but that failed (max_tokens, refusal, unparseable) still costs money.
    if (userId) await logBilledFailure({ userId, tripId: loggedTripId, functionName: 'parse-receipt', error })
    // Give the daily token back only if the model never ran.
    if (tokenConsumed && userId && !modelRan) {
      await refundIfUnbilled(serviceClient(), userId, RATE_LIMITS.parseReceipt, error)
    }
    return codedErrorResponse(error)
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
