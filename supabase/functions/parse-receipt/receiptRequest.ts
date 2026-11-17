// Request builder for the receipt parse: the system prompt, the structured-
// output schema and the per-pass messages. Shared by the edge function and by
// scripts/eval-receipts.ts so the eval exercises the real request.

import {
  MODEL_PARSE_RECEIPT,
  type AnthropicContentBlock,
  type AnthropicRequestOptions,
  type CallControl,
  type ClaudeEffort,
} from '../_shared/anthropic.ts'
import { ReceiptParseResultJsonSchema, type ReceiptParseResult } from '../_shared/contracts/receiptParseResult.ts'

/** Typical output is ~3k tokens (incl. low-effort thinking); 8192 leaves headroom for a 24-line receipt. */
export const RECEIPT_MAX_TOKENS = 8192
/** Extraction, not deliberation. Sweep low/medium in scripts/eval-receipts.ts. */
export const RECEIPT_EFFORT: ClaudeEffort = 'low'

export const RECEIPT_SYSTEM_PROMPT = `You are an expert receipt-parsing assistant. You will be shown an image (or PDF) of a purchase receipt and must extract every piece of structured information from it, precisely, into the ReceiptParseResult JSON schema you have been given as your required output format.

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

const USER_INSTRUCTION = 'Extract this receipt into the ReceiptParseResult schema.'

export interface ReceiptRequestConfig {
  model?: string
  effort?: ClaudeEffort
  repair?: { previousReceipt: ReceiptParseResult; repairPrompt: string }
  control?: CallControl
}

/**
 * Builds the request for one pass. `cache_control` stays on the system block
 * (the repair pass re-reads the same prefix within seconds); no padding is
 * added: the prompt is well over the 512-token minimum of the 5.5 generation.
 */
export function buildReceiptRequest(fileBlock: AnthropicContentBlock, cfg: ReceiptRequestConfig = {}): AnthropicRequestOptions {
  const first = {
    role: 'user' as const,
    content: [fileBlock, { type: 'text' as const, text: USER_INSTRUCTION }],
  }
  const messages = cfg.repair
    ? [
        first,
        { role: 'assistant' as const, content: JSON.stringify(cfg.repair.previousReceipt) },
        { role: 'user' as const, content: cfg.repair.repairPrompt },
      ]
    : [first]

  return {
    ...cfg.control,
    model: cfg.model ?? MODEL_PARSE_RECEIPT,
    max_tokens: RECEIPT_MAX_TOKENS,
    system: [{ type: 'text', text: RECEIPT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: {
      effort: cfg.effort ?? RECEIPT_EFFORT,
      format: { type: 'json_schema', schema: ReceiptParseResultJsonSchema.schema as Record<string, unknown> },
    },
  }
}
