/**
 * RSVP wording (UX redesign 2.3): one mapping from the seven stored
 * `confirmation_status` values to the five chips people see, plus the prompt
 * and button words. Display only — the enum and writes are unchanged.
 *
 * | Chip         | confirmation_status        |
 * | Going        | confirmed                  |
 * | Not sure     | interested, conditional    |
 * | Not going    | declined, cancelled        |
 * | No reply yet | pending                    |
 * | Waitlist     | waitlist                   |
 */
import type { ConfirmationStatus } from '../../../lib/queries/useConfirmations'

export type RsvpChip = 'going' | 'not-sure' | 'not-going' | 'no-reply' | 'waitlist'

export const RSVP_PROMPT = 'Are you coming?'

export const RSVP_BUTTON_LABELS = {
  in: "I'm in",
  'cant-say-yet': 'Not sure yet',
  out: "Can't make it",
} as const

const CHIP_FOR_STATUS: Record<ConfirmationStatus, RsvpChip> = {
  confirmed: 'going',
  interested: 'not-sure',
  conditional: 'not-sure',
  declined: 'not-going',
  cancelled: 'not-going',
  pending: 'no-reply',
  waitlist: 'waitlist',
}

const CHIP_LABEL: Record<RsvpChip, string> = {
  going: 'Going',
  'not-sure': 'Not sure',
  'not-going': 'Not going',
  'no-reply': 'No reply yet',
  waitlist: 'Waitlist',
}

/** Display order for grouped lists. */
export const RSVP_CHIP_ORDER: readonly RsvpChip[] = ['going', 'not-sure', 'no-reply', 'waitlist', 'not-going']

export function rsvpChipFor(status: ConfirmationStatus | null | undefined): RsvpChip {
  return CHIP_FOR_STATUS[status ?? 'pending']
}

export function rsvpChipLabel(chip: RsvpChip): string {
  return CHIP_LABEL[chip]
}

/** Chip text for a stored status (null/undefined means no reply yet). */
export function rsvpStatusLabel(status: ConfirmationStatus | null | undefined): string {
  return CHIP_LABEL[rsvpChipFor(status)]
}
