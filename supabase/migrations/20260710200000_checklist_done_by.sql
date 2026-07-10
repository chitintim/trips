-- trip_checklists.done_by: assignee-aware completion (People sub-task C).
-- Distinct from `assigned_to` (who's expected to bring the item) -- this
-- records who actually marked it done, so the UI can say "Alex packed it"
-- rather than just flipping a shared checkbox. Set to the current user's id
-- by useToggleChecklistItem when marking an item done, cleared back to NULL
-- when un-marking.
--
-- ADDITIVE ONLY: single nullable column, no existing data touched. The
-- existing "Creator, assignee or organizer can update checklist items" RLS
-- policy already covers writes to this column -- no new policy needed.

ALTER TABLE "public"."trip_checklists"
  ADD COLUMN IF NOT EXISTS "done_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL;

COMMENT ON COLUMN "public"."trip_checklists"."done_by" IS
  'Who actually marked the item done (may differ from assigned_to when an organizer marks on someone''s behalf). NULL when the item is not done.';
