/**
 * Debt Minimization Algorithm
 *
 * Calculates the minimum number of transactions needed to settle all debts.
 * Uses a greedy approach: repeatedly match the largest creditor with the largest debtor.
 */

export interface Person {
  userId: string
  name: string
  netBalance: number // positive = owed, negative = owes
}

export interface Transaction {
  from: string // userId who pays
  to: string // userId who receives
  fromName: string
  toName: string
  amount: number
}

/**
 * Calculate minimum transactions to settle all debts
 *
 * @param people - Array of people with their net balances (major units)
 * @param epsilon - "close enough to zero" threshold in major units. Defaults
 *   to 0.01 (one minor unit for 2-decimal currencies like GBP/USD/EUR), but
 *   callers with a different currency should pass a currency-aware value
 *   (e.g. `fromMinorUnits(1, currency)`) -- a hardcoded 0.01 is WRONG for
 *   JPY (1 minor unit = 1.00, not 0.01) and for 3-decimal currencies like
 *   BHD/KWD/JOD/OMR (1 minor unit = 0.001), and previously disagreed with
 *   computeBalances' currency-aware BALANCE_EPSILON_MINOR, so the Money
 *   position header and this settle-up screen could show contradictory
 *   "balanced" verdicts for the same trip/person.
 * @returns Array of transactions that settle all debts with minimum transfers
 */
export function minimizeTransactions(people: Person[], epsilon = 0.01): Transaction[] {
  const transactions: Transaction[] = []

  // Create working copy of balances
  const balances = people.map(p => ({
    userId: p.userId,
    name: p.name,
    balance: p.netBalance
  }))

  // Separate into creditors (positive balance) and debtors (negative balance)
  // and sort by absolute value
  const creditors = balances
    .filter(p => p.balance > epsilon) // positive = owed money
    .sort((a, b) => b.balance - a.balance) // largest first

  const debtors = balances
    .filter(p => p.balance < -epsilon) // negative = owes money
    .sort((a, b) => a.balance - b.balance) // most negative first

  let i = 0 // creditor index
  let j = 0 // debtor index

  // Greedily match largest creditor with largest debtor
  while (i < creditors.length && j < debtors.length) {
    const creditor = creditors[i]
    const debtor = debtors[j]

    // Calculate how much can be settled in this transaction
    const amountOwed = Math.abs(debtor.balance)
    const amountToReceive = creditor.balance
    const settlementAmount = Math.min(amountOwed, amountToReceive)

    // Create transaction
    transactions.push({
      from: debtor.userId,
      to: creditor.userId,
      fromName: debtor.name,
      toName: creditor.name,
      amount: settlementAmount
    })

    // Update balances
    creditor.balance -= settlementAmount
    debtor.balance += settlementAmount

    // Move to next creditor/debtor if current one is settled
    if (Math.abs(creditor.balance) < epsilon) {
      i++
    }
    if (Math.abs(debtor.balance) < epsilon) {
      j++
    }
  }

  return transactions
}

/**
 * Get simplified settlements for the current user
 * Shows what the user needs to pay or receive
 *
 * @param allTransactions - All minimized transactions
 * @param currentUserId - Current user's ID
 * @returns Transactions relevant to the current user
 */
export function getUserTransactions(
  allTransactions: Transaction[],
  currentUserId: string
): {
  toPay: Transaction[]
  toReceive: Transaction[]
} {
  return {
    toPay: allTransactions.filter(t => t.from === currentUserId),
    toReceive: allTransactions.filter(t => t.to === currentUserId)
  }
}
