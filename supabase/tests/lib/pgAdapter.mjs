// A PGlite-shaped wrapper (exec / query / close) over ONE node-postgres connection, so the same bootstrap and suites run against a real Postgres.
// Session settings (set_config(..., false)) and SET ROLE persist because it is a single connection. For concurrency tests open several adapters.
import pg from 'pg'

export async function pgAdapter(url) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  return {
    client,
    async exec(sql) { await client.query(sql) },                         // simple protocol: several statements allowed
    async query(sql, params) {
      const r = await client.query(sql, params)
      return { rows: r.rows ?? [], rowCount: r.rowCount }
    },
    async close() { await client.end() },
  }
}
