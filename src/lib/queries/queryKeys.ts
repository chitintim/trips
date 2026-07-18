/**
 * Hierarchical query key factory.
 *
 * Convention: ['trip', tripId, <domain>, ...extra]. Keys are structured so
 * that invalidating a prefix (e.g. queryKeys.trip(tripId)) cascades to every
 * more specific key nested under it — this is what makes realtime
 * invalidation (useTripRealtime) simple: one invalidateQueries call per
 * domain covers list + detail + related sub-resources.
 *
 * Non-trip-scoped domains (dashboard list of trips, current user) get their
 * own top-level branches.
 */
export const queryKeys = {
  // Dashboard / cross-trip
  trips: () => ['trips'] as const,
  currentUser: (userId: string | undefined) => ['currentUser', userId] as const,

  // Whole-trip prefix — invalidate this to blow away everything for a trip
  trip: (tripId: string) => ['trip', tripId] as const,

  tripDetail: (tripId: string) => ['trip', tripId, 'detail'] as const,
  participants: (tripId: string) => ['trip', tripId, 'participants'] as const,

  sections: (tripId: string) => ['trip', tripId, 'sections'] as const,
  options: (tripId: string) => ['trip', tripId, 'options'] as const,
  selections: (tripId: string) => ['trip', tripId, 'selections'] as const,
  votes: (tripId: string) => ['trip', tripId, 'votes'] as const,
  comments: (tripId: string) => ['trip', tripId, 'comments'] as const,
  reactions: (tripId: string) => ['trip', tripId, 'reactions'] as const,

  expenses: (tripId: string) => ['trip', tripId, 'expenses'] as const,
  expense: (tripId: string, expenseId: string) => ['trip', tripId, 'expenses', expenseId] as const,
  expenseLineItems: (tripId: string, expenseId: string) =>
    ['trip', tripId, 'expenses', expenseId, 'lineItems'] as const,
  expenseClaims: (tripId: string, expenseId: string) =>
    ['trip', tripId, 'expenses', expenseId, 'claims'] as const,
  expenseSplits: (tripId: string, expenseId: string) =>
    ['trip', tripId, 'expenses', expenseId, 'splits'] as const,

  settlements: (tripId: string) => ['trip', tripId, 'settlements'] as const,
  settlementCarryovers: (tripId: string) => ['trip', tripId, 'settlementCarryovers'] as const,

  timeline: (tripId: string) => ['trip', tripId, 'timeline'] as const,
  notes: (tripId: string) => ['trip', tripId, 'notes'] as const,

  bookings: (tripId: string) => ['trip', tripId, 'bookings'] as const,
  places: (tripId: string) => ['trip', tripId, 'places'] as const,
  activityFeed: (tripId: string) => ['trip', tripId, 'activityFeed'] as const,
  proposals: (tripId: string) => ['trip', tripId, 'proposals'] as const,
  checklists: (tripId: string) => ['trip', tripId, 'checklists'] as const,
  notifications: (tripId: string) => ['trip', tripId, 'notifications'] as const,

  confirmationSummary: (tripId: string) => ['trip', tripId, 'confirmationSummary'] as const,
  chatMessages: (tripId: string) => ['trip', tripId, 'chatMessages'] as const,
  actions: (tripId: string) => ['trip', tripId, 'actions'] as const,
} as const
