// Opens the database the suites run on: TEST_PG_URL -> a REAL Postgres (CI) through node-postgres; otherwise an in-memory PGlite.
import { PGlite } from '@electric-sql/pglite'
import { pgAdapter } from './pgAdapter.mjs'

export async function openDb() {
  if (process.env.TEST_PG_URL) return pgAdapter(process.env.TEST_PG_URL)
  return new PGlite()
}
