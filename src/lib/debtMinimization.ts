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
 * @param people - Array of people with their net balances
 * @returns Array of transactions that settle all debts with minimum transfers
 */
export function minimizeTransactions(people: Person[]): Transaction[] {
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
    .filter(p => p.balance > 0.01) // positive = owed money
    .sort((a, b) => b.balance - a.balance) // largest first

  const debtors = balances
    .filter(p => p.balance < -0.01) // negative = owes money
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
    if (Math.abs(creditor.balance) < 0.01) {
      i++
    }
    if (Math.abs(debtor.balance) < 0.01) {
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
