-- Harden trip_actions/trip_action_completions RLS: prevent an update from
-- moving an action into a trip the caller doesn't participate in, and
-- prevent a completion insert claiming a trip_id that doesn't match the
-- action's actual trip_id.

DROP POLICY IF EXISTS "Creator, assignee or organizer can update trip actions" ON public.trip_actions;
CREATE POLICY "Creator, assignee or organizer can update trip actions" ON public.trip_actions
  FOR UPDATE USING (
    (select auth.uid()) = created_by
    OR (select auth.uid()) = assigned_to
    OR public.is_trip_organizer(trip_id, (select auth.uid()))
  ) WITH CHECK (
    (
      (select auth.uid()) = created_by
      OR (select auth.uid()) = assigned_to
      OR public.is_trip_organizer(trip_id, (select auth.uid()))
    )
    AND public.is_trip_participant(trip_id, (select auth.uid()))
  );

DROP POLICY IF EXISTS "Participants can record their own completion" ON public.trip_action_completions;
CREATE POLICY "Participants can record their own completion" ON public.trip_action_completions
  FOR INSERT WITH CHECK (
    (select auth.uid()) = user_id
    AND public.is_trip_participant(trip_id, (select auth.uid()))
    AND EXISTS (
      SELECT 1 FROM public.trip_actions ta
      WHERE ta.id = action_id AND ta.trip_id = trip_action_completions.trip_id
    )
  );
