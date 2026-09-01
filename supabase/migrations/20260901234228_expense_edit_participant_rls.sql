-- Bug fix (2026-09-02 incident: Leo Fang, then role='participant', trip
-- "Sailing Sicily" 46efa496-11b6-49c8-b229-c72161f59126): editing an
-- existing expense he didn't pay for and wasn't yet organizer of failed on
-- the wizard's final save step with "Failed to save expense".
--
-- Root cause: useUpdateExpense (src/lib/queries/useExpenses.ts) lets any
-- trip participant open and edit ANY expense in the trip -- the UI never
-- gates the Edit action behind paid_by/organizer
-- (src/features/expenses/expenses-tab/ExpenseCard.tsx has no such check),
-- and the sibling INSERT policies already match that intent:
--   - "Participants can create expenses": any participant, any paid_by
--   - "Participants can create splits for trip expenses": any participant
--     may write a split row for ANY other participant
-- But the UPDATE policies were never widened to match when edit landed --
-- expenses.UPDATE and expense_splits.UPDATE/DELETE stayed restricted to
-- "paid_by = auth.uid()" or "organizer", a leftover from before per-field
-- editing existed (see EXPENSE_SYSTEM_PLAN.md's original "UPDATE: Never"
-- for expense_splits).
--
-- Concretely, for a plain participant editing someone else's expense:
--   1. `expenses.update(...)` matches 0 rows under RLS and returns success
--      with no error (supabase-js only surfaces an error, not affected-row
--      count, on a bare .update() with no .select()) -- so header changes
--      silently vanish.
--   2. The expense_splits upsert (`.upsert(rows, { onConflict:
--      'expense_id,user_id' })`) becomes INSERT ... ON CONFLICT DO UPDATE.
--      Postgres re-checks the *existing* conflicting rows against the
--      UPDATE policies' USING clauses (WCO_RLS_CONFLICT_CHECK) before
--      applying the update, which is the ONLY code path that produces the
--      distinctive error text "... (USING expression) ...". It fails the
--      instant it reaches a split row the caller doesn't own, is not the
--      trip organizer for, and didn't pay for.
--
-- Reproduced (read-only) against expense ede17b7f-816f-43a1-97f5-180484c38b7d
-- ("Panarea Docking Fee", 130 EUR) with a plain-participant uid
-- (78d45125-104a-461d-8fad-cf83e6b65d50, not payer/organizer): the exact
-- upsert useUpdateExpense issues raised
--   `new row violates row-level security policy (USING expression) for
--   table "expense_splits"`
-- byte-for-byte matching the rows logged in client_errors for Leo's user id
-- (14959d22-cc69-4224-8652-af68a70c6a71) at 2026-09-01 16:28:40 and
-- 16:29:29. No orphaned expenses/splits resulted (the header update was a
-- silent no-op, not a partial write, and the splits statement is atomic --
-- it never partially applied).
--
-- Fix: widen expenses.UPDATE and expense_splits.UPDATE/DELETE to any trip
-- participant, matching the already-permissive INSERT policies and the
-- gate-free edit UI. Written as ADDITIVE new policies (ORed with the
-- existing creator/organizer ones via RLS's permissive-OR semantics)
-- rather than replacing the existing policies, to keep this change minimal
-- and low-risk. Deleting an expense outright is intentionally left
-- untouched (still creator/organizer/admin only) -- only in-place editing
-- (which the UI already exposes to every participant) is being unblocked.
CREATE POLICY "Participants can update trip expenses" ON public.expenses
  FOR UPDATE USING (
    public.is_trip_participant(trip_id, (select auth.uid()))
  );

CREATE POLICY "Participants can update trip expense splits" ON public.expense_splits
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE expenses.id = expense_splits.expense_id
      AND public.is_trip_participant(expenses.trip_id, (select auth.uid()))
    )
  );

-- Needed alongside UPDATE: useUpdateExpense also deletes expense_splits
-- rows for participants removed from the split during an edit
-- (`removedUserIds`), which hits the exact same creator/organizer-only gap.
CREATE POLICY "Participants can delete trip expense splits" ON public.expense_splits
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE expenses.id = expense_splits.expense_id
      AND public.is_trip_participant(expenses.trip_id, (select auth.uid()))
    )
  );
