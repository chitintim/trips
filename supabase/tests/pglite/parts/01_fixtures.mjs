// ---- fixtures -------------------------------------------------------------------------------------------------------
const mkExpense = async ({ trip = T, payer = 2, amount, currency = 'EUR', desc, itemised = true, status = 'unallocated', tagged = null, lines = [] }) => {
  const id = (await db.query(`insert into expenses(trip_id,paid_by,amount,currency,description,status,ai_parsed,participant_ids) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [trip, U(payer), amount, currency, desc, status, itemised, tagged ? tagged.map(U) : null])).rows[0].id
  const ids = []
  let n = 0
  for (const [name, qty, total] of lines) {
    ids.push((await db.query(`insert into expense_line_items(expense_id,name_original,quantity,unit_price,subtotal,total_amount,line_number) values ($1,$2,$3,$4,$5,$5,$6) returning id`, [id, name, qty, total / qty, total, ++n])).rows[0].id)
  }
  return { id, lines: ids }
}
const claimRows = async eid => (await db.query(`select line_item_id l, user_id::text u, quantity_claimed::float q, amount_owed::float a, source s, created_by::text cb, leftover_quantity::float lq, leftover_amount::float la from expense_item_claims where expense_id=$1 order by line_item_id, user_id, source`, [eid])).rows
const statusOf = async eid => (await db.query(`select status::text s from expenses where id=$1`, [eid])).rows[0].s
const lineSums = async eid => (await db.query(`select li.line_number n, li.total_amount::float t, li.quantity::float qty, coalesce(sum(c.amount_owed),0)::float a, coalesce(sum(c.quantity_claimed),0)::float q from expense_line_items li left join expense_item_claims c on c.line_item_id=li.id where li.expense_id=$1 group by li.id order by li.line_number`, [eid])).rows
const near = (a, b) => Math.abs(a - b) < 1e-9
const cents = x => Math.round(x * 100)
