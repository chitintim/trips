/**
 * The read tools of the trip assistant (slice A2). All of them read with the
 * CALLER's client (RLS applies), apply the app's own visibility rules on top,
 * speak plain words (never stored enum values) and wrap member-written text
 * with tripData().
 *
 * READ_TOOLS order is fixed: it is part of the cached tool prefix.
 */
import type { ToolModule } from '../types.ts'
import { getMyTodosTool, getWaitingOnTool } from './todos.ts'
import { getQuestionTool, listQuestionsTool } from './questions.ts'
import { getBalancesTool, getMyMoneyTool } from './money.ts'
import { getReceiptTool, listExpensesTool } from './expenses.ts'
import { getPlanTool } from './plan.ts'
import { getPeopleTool } from './people.ts'
import { getChangesTool } from './changes.ts'
import { searchPlacesTool } from './places.ts'

export const READ_TOOLS: ToolModule[] = [
  getMyTodosTool,
  getWaitingOnTool,
  listQuestionsTool,
  getQuestionTool,
  getMyMoneyTool,
  getBalancesTool,
  listExpensesTool,
  getReceiptTool,
  getPlanTool,
  getPeopleTool,
  getChangesTool,
  searchPlacesTool,
]

// Per-turn digest helpers (never throw; null / 0 on failure).
export { computeMyTodoDigest, type DigestItem, type TodoDigest, type TodoSource } from './todos.ts'
export { computeMyMoneyLine } from './money.ts'
export { questionsNeedingMyAnswer } from './questions.ts'
// Plain-word helpers for the system prompt / trip block.
export { stageWords, statusWords, shapeWords, rsvpWords } from './shared.ts'
export { buildTripSnapshot } from '../../../_shared/todos/snapshot.ts'
