/**
 * MANUAL COPY of src/shared/contracts/*.
 *
 * Deno (Supabase Edge Functions) cannot import across the supabase/functions
 * boundary from src/, so this directory is a faithful, hand-synced copy of
 * the frontend's Zod contracts (only the `from 'zod'` import specifier
 * differs -> `from 'npm:zod@3'`).
 *
 * IMPORTANT: If you change src/shared/contracts/*, mirror the change here
 * too. WSH (coordinator) is adding an automated drift-check (byte-diff after
 * normalizing the import specifier) to CI -- until that lands, keep this in
 * sync by hand. Last synced: 2026-07-06, against the WS0 foundation commit
 * (666b3b5) contracts.
 */
export * from './common.ts'
export * from './receiptParseResult.ts'
export * from './ingestResult.ts'
export * from './chatToolContracts.ts'
export * from './nudgeDraft.ts'
export * from './aiProposal.ts'
