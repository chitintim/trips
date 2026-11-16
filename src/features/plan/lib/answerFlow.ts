/**
 * Pure stepping logic for AnswerFlow (slice 2C): which questions are in the
 * flow, "2 of 5", whether Next is allowed and what the finish screen can
 * truthfully say. The set of questions is frozen when the flow opens, so
 * answering one never shortens the list underneath the person.
 */
import type { AnswerControlModel } from '../../decisions/lib/answerModel'

type MyState = AnswerControlModel['myState']

export interface FlowSection {
  id: string
}

/** Unique ids, in the order the caller supplied them. */
export function freezeFlowIds(sections: ReadonlyArray<FlowSection>): string[] {
  return Array.from(new Set(sections.map((s) => s.id)))
}

/** The frozen ids resolved against the live sections (a question deleted meanwhile drops out). */
export function resolveFlowSteps<S extends FlowSection>(ids: ReadonlyArray<string>, live: ReadonlyArray<S>): S[] {
  const byId = new Map(live.map((s) => [s.id, s]))
  return ids.flatMap((id) => {
    const s = byId.get(id)
    return s ? [s] : []
  })
}

export function progressLabel(index: number, total: number): string {
  return `${Math.min(index + 1, total)} of ${total}`
}

export interface StepRecord {
  state: MyState
  /** Nothing to answer here (closed, decided, finished trip, not coming). */
  closed: boolean
}

/** Next needs an answer or a pass, unless there is nothing to answer on this step. */
export function canAdvance(record: StepRecord | undefined): boolean {
  if (!record) return false
  return record.closed || record.state !== 'unanswered'
}

export type StepOutcome = 'answered' | 'passed' | 'closed' | 'skipped'

export function stepOutcome(record: StepRecord | undefined): StepOutcome {
  if (!record) return 'skipped'
  if (record.state === 'answered') return 'answered'
  if (record.state === 'passed') return 'passed'
  return record.closed ? 'closed' : 'skipped'
}

export interface FlowSummary {
  answered: number
  passed: number
  closed: number
  /** Question ids still needing an answer, in flow order. */
  skippedIds: string[]
  headline: string
  detail: string
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What the finish screen says, from the last known state of each step (never claims "all done" while any is skipped). */
export function summariseFlow(ids: ReadonlyArray<string>, records: Readonly<Record<string, StepRecord>>): FlowSummary {
  let answered = 0
  let passed = 0
  let closed = 0
  const skippedIds: string[] = []
  for (const id of ids) {
    const outcome = stepOutcome(records[id])
    if (outcome === 'answered') answered += 1
    else if (outcome === 'passed') passed += 1
    else if (outcome === 'closed') closed += 1
    else skippedIds.push(id)
  }
  if (ids.length === 0) return { answered, passed, closed, skippedIds, headline: 'Nothing needs your answer', detail: 'There are no open questions for you right now.' }
  const done = answered + passed
  const bits: string[] = []
  if (answered) bits.push(`${plural(answered, 'answer', 'answers')} saved`)
  if (passed) bits.push(`${plural(passed, 'question', 'questions')} passed on`)
  if (closed) bits.push(`${plural(closed, 'question', 'questions')} already closed`)
  if (skippedIds.length > 0) {
    return {
      answered,
      passed,
      closed,
      skippedIds,
      headline: `${plural(skippedIds.length, 'question still needs', 'questions still need')} your answer`,
      detail: bits.length ? `${bits.join(', ')}.` : 'You skipped every question.',
    }
  }
  return {
    answered,
    passed,
    closed,
    skippedIds,
    headline: done > 0 ? "You're all caught up" : 'Nothing needed your answer',
    detail: bits.length ? `${bits.join(', ')}.` : '',
  }
}
