
console.log(`\n${pass} passed, ${fail} failed`)
await db.close?.()
process.exit(fail ? 1 : 0)
