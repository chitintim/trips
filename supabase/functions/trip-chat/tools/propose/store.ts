/**
 * The ONLY writer in the propose tools: one chat_actions row via the service
 * role. Everything else in tools/propose is read-only. Fail-soft when the
 * table (or a column) is not there yet.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import type { Json } from '../types.ts'

export interface ChatActionInsert {
  trip_id: string
  user_id: string
  turn_id: string
  kind: string
  params: Json
  preview: Json
  basis: Json
  requires: 'tap' | 'review'
  status: 'proposed'
}

export interface StoredRow {
  id: string
  status: string
  expires_at: string | null
  created_at: string | null
}

interface DbErr {
  code?: string
  message?: string
}

/** Missing table / column: the migration has not been applied yet. */
export function isMissingTableError(err: DbErr | null | undefined): boolean {
  if (!err) return false
  const code = err.code ?? ''
  return code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204'
}

export type InsertOutcome =
  | { ok: true; row: StoredRow }
  | { ok: false; missing: true }
  | { ok: false; missing: false; duplicate: true }
  | { ok: false; missing: false; duplicate?: false; message: string }

export async function insertChatAction(admin: SupabaseClient, row: ChatActionInsert): Promise<InsertOutcome> {
  try {
    const { data, error } = await admin.from('chat_actions').insert(row).select('id,status,expires_at,created_at').single()
    if (error) {
      if (isMissingTableError(error)) return { ok: false, missing: true }
      // unique index (trip, user, turn, kind, md5(params)): the same proposal already exists in this turn
      if ((error as DbErr).code === '23505') return { ok: false, missing: false, duplicate: true }
      return { ok: false, missing: false, message: error.message ?? 'insert failed' }
    }
    return { ok: true, row: data as StoredRow }
  } catch (e) {
    return { ok: false, missing: false, message: e instanceof Error ? e.message : 'insert failed' }
  }
}

export type ExistingOutcome =
  | { found: StoredRow & { params: Json; preview: Json; basis: Json; requires: 'tap' | 'review' } }
  | { found: null }
  | { missing: true }

/** A row with the same (trip, user, turn, kind) whose params are identical, if any. */
export async function findExistingAction(
  admin: SupabaseClient,
  q: { trip_id: string; user_id: string; turn_id: string; kind: string },
  paramsKey: string,
  keyOf: (p: unknown) => string,
): Promise<ExistingOutcome> {
  try {
    const { data, error } = await admin
      .from('chat_actions')
      .select('id,status,expires_at,created_at,params,preview,basis,requires')
      .eq('trip_id', q.trip_id)
      .eq('user_id', q.user_id)
      .eq('turn_id', q.turn_id)
      .eq('kind', q.kind)
    if (error) {
      if (isMissingTableError(error)) return { missing: true }
      return { found: null }
    }
    const hit = ((data ?? []) as Array<StoredRow & { params: Json; preview: Json; basis: Json; requires: 'tap' | 'review' }>).find(
      (r) => keyOf(r.params) === paramsKey,
    )
    return { found: hit ?? null }
  } catch {
    return { found: null }
  }
}
