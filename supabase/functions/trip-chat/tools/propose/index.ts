/** The propose tools (slice A3), in the fixed order the tool list uses. Never per user: the same list for everyone. */
import type { ToolModule } from '../types.ts'
import { proposeAddExpense } from './addExpense.ts'
import { proposeAddOption } from './addOption.ts'
import { proposeAddPlanItem } from './addPlanItem.ts'
import { proposeAddTodo } from './addTodo.ts'
import { proposeAnswer } from './answer.ts'
import { proposeCreateQuestion } from './createQuestion.ts'
import { openScreen } from './openScreen.ts'
import { proposeSetMyTravel } from './setMyTravel.ts'
import { proposeSuggestOption } from './suggestOption.ts'
import { proposeTickTodo } from './tickTodo.ts'

export const PROPOSE_TOOLS: readonly ToolModule[] = [
  proposeAddTodo,
  proposeSetMyTravel,
  proposeAddPlanItem,
  proposeTickTodo,
  proposeAnswer,
  proposeAddExpense,
  proposeSuggestOption,
  proposeCreateQuestion,
  proposeAddOption,
  openScreen,
]

export type * from './cards.ts'
export { OPEN_TARGETS, formatOpenParam } from './deepLinks.ts'
export { largestRemainderDistribute, parseDecimalToMinor, formatMinor } from './money.ts'
