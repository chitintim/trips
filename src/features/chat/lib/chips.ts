export type ChatSpace = 'today' | 'plan' | 'money' | 'people'

export interface ChatChip {
  label: string
  /** Question chips send straight away; action chips put the start of a sentence in the box for the person to finish. */
  insert?: string
}

const CONTEXT_TO_SPACE: Record<string, ChatSpace> = {
  today: 'today',
  overview: 'today',
  default: 'today',
  plan: 'plan',
  decisions: 'plan',
  itinerary: 'plan',
  map: 'plan',
  organizer: 'plan',
  money: 'money',
  expenses: 'money',
  'my-spending': 'money',
  'settle-up': 'money',
  people: 'people',
}

export function spaceFor(context: string | undefined): ChatSpace {
  return CONTEXT_TO_SPACE[context ?? 'default'] ?? 'today'
}

/** Starter chips per space: two questions, two things it can do. */
export function chipsFor(space: ChatSpace, isOrganizer: boolean): ChatChip[] {
  switch (space) {
    case 'today':
      return [
        { label: 'What do I need to do?' },
        { label: 'What changed since I last looked?' },
        { label: 'Add a to-do', insert: 'Add a to-do: ' },
        { label: 'Remind me to…', insert: 'Remind me to ' },
      ]
    case 'plan':
      // Four chips in every space. Organisers can both make a poll and suggest an idea, so they trade the "leading" question for the second action.
      return isOrganizer
        ? [
            { label: "What's still undecided?" },
            { label: 'Vote for me…', insert: 'Vote for ' },
            { label: 'Make a poll', insert: 'Make a poll: ' },
            { label: 'Suggest an idea', insert: 'Suggest an idea: ' },
          ]
        : [
            { label: "What's still undecided?" },
            { label: "What's leading on the open questions?" },
            { label: 'Vote for me…', insert: 'Vote for ' },
            { label: 'Suggest an idea', insert: 'Suggest an idea: ' },
          ]
    case 'money':
      return [{ label: 'What do I owe?' }, { label: 'Who had what on the latest receipt?' }, { label: 'Add an expense', insert: 'Add an expense: I paid ' }, { label: 'Split something between us', insert: 'Split between us: ' }]
    case 'people':
      return [
        { label: "Who hasn't replied?" },
        { label: "Who's arriving when?" },
        ...(isOrganizer ? [{ label: 'Draft a nudge for people who haven’t answered', insert: 'Draft a nudge for people who haven’t answered' }] : []),
      ]
  }
}
