import { describe, it, expect } from 'vitest'
import { parseProposalActions, describeAction } from './applyProposal'
import type { Json } from '../../../types/database.types'

const TRIP_ID = '11111111-1111-4111-8111-111111111111'
const OPTION_ID = '22222222-2222-4222-8222-222222222222'
const SECTION_ID = '33333333-3333-4333-8333-333333333333'

function actions(list: unknown[]): Json {
  return list as unknown as Json
}

describe('parseProposalActions — new action types (validation)', () => {
  it('accepts a valid update_option action', () => {
    const [entry] = parseProposalActions(
      actions([
        {
          type: 'update_option',
          idempotency_key: 'k1',
          option_id: OPTION_ID,
          title: 'Ski pack — Blue',
          metadata_patch: { pricing: { variants: [{ label: 'Blue', per_day: 25 }] } },
        },
      ])
    )
    expect(entry.error).toBeNull()
    expect(entry.action?.type).toBe('update_option')
  })

  it('rejects update_option missing option_id', () => {
    const [entry] = parseProposalActions(actions([{ type: 'update_option', idempotency_key: 'k1', title: 'x' }]))
    expect(entry.action).toBeNull()
    expect(entry.error).toBeTruthy()
  })

  it('accepts a valid create_section action', () => {
    const [entry] = parseProposalActions(
      actions([
        {
          type: 'create_section',
          idempotency_key: 'k1',
          trip_id: TRIP_ID,
          title: 'How are we getting there?',
          section_type: 'transport',
          decision_shape: 'vote',
        },
      ])
    )
    expect(entry.error).toBeNull()
    expect(entry.action?.type).toBe('create_section')
  })

  it('rejects create_section with an invalid section_type', () => {
    const [entry] = parseProposalActions(
      actions([
        {
          type: 'create_section',
          idempotency_key: 'k1',
          trip_id: TRIP_ID,
          title: 'Ski & board rental',
          section_type: 'not_a_real_type',
          decision_shape: 'personal',
        },
      ])
    )
    expect(entry.action).toBeNull()
  })

  it('accepts a valid update_section action with a metadata_patch', () => {
    const [entry] = parseProposalActions(
      actions([
        { type: 'update_section', idempotency_key: 'k1', section_id: SECTION_ID, metadata_patch: { decision_shape: 'personal' } },
      ])
    )
    expect(entry.error).toBeNull()
    expect(entry.action?.type).toBe('update_section')
  })

  it('accepts move_option with a real uuid target section', () => {
    const [entry] = parseProposalActions(
      actions([{ type: 'move_option', idempotency_key: 'k1', option_id: OPTION_ID, to_section_id: SECTION_ID }])
    )
    expect(entry.error).toBeNull()
    expect(entry.action?.type).toBe('move_option')
  })

  it('accepts move_option targeting a same-batch create_section via a ref: placeholder', () => {
    const [entry] = parseProposalActions(
      actions([{ type: 'move_option', idempotency_key: 'k1', option_id: OPTION_ID, to_section_id: 'ref:new-ski-pack' }])
    )
    expect(entry.error).toBeNull()
    expect(entry.action?.type).toBe('move_option')
  })

  it('rejects move_option with a malformed to_section_id (neither a uuid nor a ref: token)', () => {
    const [entry] = parseProposalActions(
      actions([{ type: 'move_option', idempotency_key: 'k1', option_id: OPTION_ID, to_section_id: 'not-a-uuid-or-ref' }])
    )
    expect(entry.action).toBeNull()
  })

  it('accepts create_option whose section_id is a ref: placeholder (new "Ski pack" catalog scenario)', () => {
    const [entry] = parseProposalActions(
      actions([
        {
          type: 'create_option',
          idempotency_key: 'k2',
          section_id: 'ref:new-ski-pack',
          title: 'Ski pack — Blue',
        },
      ])
    )
    expect(entry.error).toBeNull()
    expect(entry.action?.type).toBe('create_option')
  })
})

describe('describeAction — new action types', () => {
  it('describes update_option, preferring a resolved option title over the id/action title', () => {
    const desc = describeAction(
      {
        type: 'update_option',
        idempotency_key: 'k1',
        option_id: OPTION_ID,
        price: 25,
        currency: 'GBP',
      },
      { optionTitles: new Map([[OPTION_ID, 'Blue pack — Adult']]) }
    )
    expect(desc.title).toBe('Update option')
    expect(desc.summary).toContain('Blue pack — Adult')
    expect(desc.summary).toContain('GBP 25')
    expect(desc.isDelete).toBe(false)
  })

  it('describes update_option with no context/fields as a no-op change', () => {
    const desc = describeAction({ type: 'update_option', idempotency_key: 'k1', option_id: OPTION_ID })
    expect(desc.summary).toContain('no field changes')
  })

  it('describes create_section with the question wording and shape', () => {
    const desc = describeAction({
      type: 'create_section',
      idempotency_key: 'k1',
      trip_id: TRIP_ID,
      title: 'Ski & board rental',
      section_type: 'equipment',
      decision_shape: 'personal',
    })
    expect(desc.title).toBe('New question')
    expect(desc.summary).toBe('"Ski & board rental" (Personal picks)')
  })

  it('describes create_section as a group vote when decision_shape is vote', () => {
    const desc = describeAction({
      type: 'create_section',
      idempotency_key: 'k1',
      trip_id: TRIP_ID,
      title: 'How are we getting there?',
      section_type: 'transport',
      decision_shape: 'vote',
    })
    expect(desc.summary).toContain('Group vote')
  })

  it('describes update_section using a resolved section title', () => {
    const desc = describeAction(
      { type: 'update_section', idempotency_key: 'k1', section_id: SECTION_ID, vote_deadline: null },
      { sectionTitles: new Map([[SECTION_ID, 'Where are we staying?']]) }
    )
    expect(desc.summary).toContain('Where are we staying?')
    expect(desc.summary).toContain('deadline → cleared')
  })

  it('describes move_option resolving both the option and a ref-targeted new section', () => {
    const desc = describeAction(
      { type: 'move_option', idempotency_key: 'k1', option_id: OPTION_ID, to_section_id: 'ref:new-ski-pack' },
      {
        optionTitles: new Map([[OPTION_ID, 'Blue run access']]),
        sectionTitles: new Map([['ref:new-ski-pack', 'Ski & board rental']]),
      }
    )
    expect(desc.title).toBe('Move option')
    expect(desc.summary).toBe('"Blue run access" → "Ski & board rental"')
  })

  it('describes move_option with unresolved titles falling back to generic text', () => {
    const desc = describeAction({ type: 'move_option', idempotency_key: 'k1', option_id: OPTION_ID, to_section_id: SECTION_ID })
    expect(desc.summary).toBe('Option → another question')
  })
})
