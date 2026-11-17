/** A `receipt-claim` peek payload for tests. */
export const payload = (over: Record<string, unknown> = {}) => ({
  expense: { id: 'e1', title: 'Le Bistrot', currency: 'GBP', amount: 120, payer_id: 'p', payer_first_name: 'Tim', trip_id: 't1', trip_name: 'Alps' },
  me: { user_id: 'u', first_name: 'Marj', is_payer: false },
  on_receipt: true,
  response: null,
  deadline: '2026-11-20T18:00:00Z',
  sent_at: '2026-11-17T10:00:00Z',
  closed_at: null,
  frozen: false,
  editable: true,
  closed_reason: null,
  my_items: [
    { line_item_id: 'l1', name: 'Pizza', name_english: null, quantity: 1, total: 30, shared_by_all: false, my_quantity: 1, my_amount: 10, leftover_amount: 0, others: ['Sam', 'Alex'], can_toggle: true },
    { line_item_id: 'l2', name: 'Wine', name_english: 'Red wine', quantity: 1, total: 32, shared_by_all: false, my_quantity: 1, my_amount: 32, leftover_amount: 0, others: [], can_toggle: true },
  ],
  available_items: [{ line_item_id: 'l3', name: 'Bread', name_english: null, quantity: 1, total: 4, others: [] }],
  my_total: 42,
  my_leftover_total: 0,
  unclaimed_total: 4,
  notices_enabled: true,
  ...over,
})

