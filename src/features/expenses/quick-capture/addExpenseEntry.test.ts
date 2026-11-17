import { describe, it, expect } from 'vitest'
import { addExpenseBlockedMessage, FROZEN_EXPENSES_MESSAGE, ADD_EXPENSE_LABEL, SCAN_RECEIPT_CHOICE, ENTER_YOURSELF_CHOICE } from './addExpenseEntry'

describe('addExpenseEntry', () => {
  it('blocks only when balances are frozen', () => {
    expect(addExpenseBlockedMessage({ settlement_snapshot: null })).toBeNull()
    expect(addExpenseBlockedMessage({})).toBeNull()
    expect(addExpenseBlockedMessage({ settlement_snapshot: { x: 1 } })).toBe(FROZEN_EXPENSES_MESSAGE)
  })
  it('uses the agreed labels', () => {
    expect(ADD_EXPENSE_LABEL).toBe('Add expense')
    expect(SCAN_RECEIPT_CHOICE.label).toBe('Scan a receipt')
    expect(ENTER_YOURSELF_CHOICE.label).toBe('Enter it yourself')
  })
})
