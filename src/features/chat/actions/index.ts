import type { ActionKind } from '../lib/payload'
import type { ActionModule } from './types'
import { addTodoModule } from './addTodo'
import { tickTodoModule } from './tickTodo'
import { answerModule } from './answer'
import { addExpenseModule } from './addExpense'
import { suggestOptionModule } from './suggestOption'
import { createQuestionModule } from './createQuestion'
import { addOptionModule } from './addOption'
import { setTravelModule } from './setTravel'
import { addPlanItemModule } from './addPlanItem'

/** Executors per kind. `open_screen` has none: it is a link, never a write. */
export const MODULES: Record<Exclude<ActionKind, 'open_screen'>, ActionModule> = {
  add_todo: addTodoModule,
  tick_todo: tickTodoModule,
  answer: answerModule,
  add_expense: addExpenseModule,
  suggest_option: suggestOptionModule,
  create_question: createQuestionModule,
  add_option: addOptionModule,
  set_travel: setTravelModule,
  add_plan_item: addPlanItemModule,
}

export function moduleFor(kind: ActionKind): ActionModule | null {
  return kind === 'open_screen' ? null : MODULES[kind]
}
