/**
 * Pure grouping for the Today "Who's coming" card. Uses the one RSVP
 * vocabulary (people/lib/rsvpLabels). Inactive people are excluded. With
 * confirmation tracking off there is no reply to show, so everyone is listed
 * in one flat group.
 */
import { RSVP_CHIP_ORDER, rsvpChipFor, rsvpChipLabel, type RsvpChip } from '../../people/lib/rsvpLabels'
import type { ConfirmationStatus } from '../../../lib/queries/useConfirmations'

export interface WhosInPerson {
  id: string
  name: string | null | undefined
  status: ConfirmationStatus | null | undefined
  active?: boolean | null
}

export interface WhosInEntry {
  id: string
  fullName: string
  firstName: string
}

export interface WhosInGroup {
  chip: RsvpChip | 'everyone'
  label: string
  count: number
  people: WhosInEntry[]
}

export interface WhosInModel {
  heading: string
  total: number
  goingCount: number
  groups: WhosInGroup[]
}

export function firstNameOf(name: string | null | undefined): string {
  const t = (name ?? '').trim()
  return t ? t.split(/\s+/)[0] : 'Someone'
}

export function buildWhosIn(people: WhosInPerson[], trackingOn: boolean): WhosInModel {
  const active = people.filter((p) => p.active !== false)
  const entry = (p: WhosInPerson): WhosInEntry => ({
    id: p.id,
    fullName: (p.name ?? '').trim() || 'Someone',
    firstName: firstNameOf(p.name),
  })
  const goingCount = active.filter((p) => rsvpChipFor(p.status) === 'going').length

  if (!trackingOn) {
    return {
      heading: `Who's on this trip · ${active.length}`,
      total: active.length,
      goingCount,
      groups: active.length ? [{ chip: 'everyone', label: 'On the trip', count: active.length, people: active.map(entry) }] : [],
    }
  }

  const groups: WhosInGroup[] = []
  for (const chip of RSVP_CHIP_ORDER) {
    const members = active.filter((p) => rsvpChipFor(p.status) === chip)
    if (members.length) groups.push({ chip, label: rsvpChipLabel(chip), count: members.length, people: members.map(entry) })
  }
  return { heading: `Who's coming · ${goingCount} going · ${active.length} invited`, total: active.length, goingCount, groups }
}
