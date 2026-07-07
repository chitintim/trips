/**
 * Persisted dismissals for Today's suggestion/onboarding cards
 * (UX_REDESIGN.md Part 2: NEXT-STEPS card + stage-advance suggestions are
 * dismissible; localStorage per trip is the documented persistence).
 */
const keyFor = (tripId: string, cardKey: string) => `trips.today.dismissed.${tripId}.${cardKey}`

export function isCardDismissed(tripId: string, cardKey: string): boolean {
  try {
    return localStorage.getItem(keyFor(tripId, cardKey)) === '1'
  } catch {
    return false
  }
}

export function dismissCard(tripId: string, cardKey: string): void {
  try {
    localStorage.setItem(keyFor(tripId, cardKey), '1')
  } catch {
    // Private mode / quota — dismissal just won't persist.
  }
}
