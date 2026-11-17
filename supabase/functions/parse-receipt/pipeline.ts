// The parse pipeline: first pass, deterministic reconciliation, and ONE
// repair re-prompt when nothing reconciles. Shared by the edge function and
// scripts/eval-receipts.ts. The model call is injectable for tests.

import {
  BilledAiCallError,
  billedUsageOf,
  createMessage,
  extractText,
  type AnthropicContentBlock,
  type AnthropicUsage,
  type CallControl,
  type ClaudeEffort,
} from '../_shared/anthropic.ts'
import { AiCallError } from '../_shared/aiError.ts'
import { reconcileReceipt, buildRepairPrompt, type ReconciliationResult } from '../_shared/receiptReconciliation.ts'
import { ReceiptParseResultSchema, type ReceiptParseResult } from '../_shared/contracts/receiptParseResult.ts'
import { buildReceiptRequest } from './receiptRequest.ts'

export interface PipelineConfig {
  model?: string
  effort?: ClaudeEffort
  control?: CallControl
  /** Test / eval seam; defaults to createMessage. */
  call?: typeof createMessage
}

export interface PipelineResult {
  parsed: ReceiptParseResult
  reconciliation: ReconciliationResult
  /** A repair re-prompt was attempted. */
  repairAttempted: boolean
  /** The repaired result reconciled and replaced the first pass. */
  repairAdopted: boolean
  usage: AnthropicUsage
  /** Model that served the first pass (as reported by the API). */
  model: string
}

export function addUsage(a: AnthropicUsage, b: AnthropicUsage): AnthropicUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  }
}

/** JSON + schema validation of the model's text; any failure is the coded 'unreadable'. */
export function parseReceiptText(text: string): ReceiptParseResult {
  try {
    return ReceiptParseResultSchema.parse(JSON.parse(text))
  } catch {
    throw new AiCallError('unreadable', 'response did not match ReceiptParseResult')
  }
}

export async function runReceiptPipeline(fileBlock: AnthropicContentBlock, cfg: PipelineConfig = {}): Promise<PipelineResult> {
  const call = cfg.call ?? createMessage
  const base = { model: cfg.model, effort: cfg.effort, control: cfg.control }

  const first = await call(buildReceiptRequest(fileBlock, base))
  let usage = { ...first.usage }
  let parsed: ReceiptParseResult
  try {
    parsed = parseReceiptText(extractText(first))
  } catch (err) {
    // The first call was charged even though its output was unusable: carry the usage out.
    throw err instanceof AiCallError && !(err instanceof BilledAiCallError) ? new BilledAiCallError(err, usage, first.model) : err
  }
  let reconciliation = reconcileReceipt(parsed)
  let repairAttempted = false
  let repairAdopted = false

  if (!reconciliation.reconciled) {
    repairAttempted = true
    let pendingRepairUsage = true
    try {
      const repairPrompt = buildRepairPrompt(parsed, reconciliation)
      const repairResponse = await call(
        buildReceiptRequest(fileBlock, { ...base, repair: { previousReceipt: parsed, repairPrompt } })
      )
      usage = addUsage(usage, repairResponse.usage)
      pendingRepairUsage = false
      const repaired = parseReceiptText(extractText(repairResponse))
      const repairedReconciliation = reconcileReceipt(repaired)
      // Adopt the repair only if it reconciles; otherwise keep the first pass
      // (still printed-total-trusted either way).
      if (repairedReconciliation.reconciled) {
        parsed = repaired
        reconciliation = repairedReconciliation
        repairAdopted = true
      }
    } catch (repairError) {
      // A repair that was charged but failed (max_tokens, unparseable) still cost money.
      if (pendingRepairUsage) {
        const billed = billedUsageOf(repairError)
        if (billed) usage = addUsage(usage, billed.usage)
      }
      console.error('[parse-receipt] repair re-prompt failed:', repairError instanceof AiCallError ? repairError.code : 'error')
      // fall through with the first-pass parse
    }
  }

  return { parsed, reconciliation, repairAttempted, repairAdopted, usage, model: first.model }
}
