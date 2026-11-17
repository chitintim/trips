// Connections for the concurrency tests. REAL mode (TEST_PG_URL): every openConn() is its own connection (true concurrency). Smoke mode (no TEST_PG_URL): one shared PGlite,
// and exclusive() serialises whole transactions, so the scenarios still run (without any real interleaving).
import { openDb } from '../lib/openDb.mjs'

let chain = Promise.resolve()
let shared = null

export async function openConn() {
  if (process.env.TEST_PG_URL) {
    const db = await openDb()
    db.exclusive = fn => fn()
    return db
  }
  shared ??= await openDb()
  return {
    exec: s => shared.exec(s),
    query: (s, p) => shared.query(s, p),
    close: async () => {},
    exclusive: fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p },
  }
}
