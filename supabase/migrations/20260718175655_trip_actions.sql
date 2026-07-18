-- Trip Actions: lightweight assignable to-dos scoped to a trip, distinct
-- from trip_checklists. Supports a "whole group" assignment (assigned_to
-- IS NULL) tracked via per-user completion rows in
-- trip_action_completions, alongside a single-assignee fast path tracked
-- directly on trip_actions (completed_at/completed_by).

CREATE TABLE public.trip_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) <= 300),
  notes text CHECK (char_length(notes) <= 2000),
  created_by uuid NOT NULL REFERENCES public.users(id),
  assigned_to uuid REFERENCES public.users(id) ON DELETE SET NULL, -- NULL = whole group
  deadline_kind text NOT NULL DEFAULT 'fixed' CHECK (deadline_kind IN ('fixed','before_trip')),
  due_date date,
  completed_at timestamptz,
  completed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_actions_due_when_fixed CHECK (deadline_kind <> 'fixed' OR due_date IS NOT NULL)
);
CREATE INDEX trip_actions_trip_id_idx ON public.trip_actions (trip_id);

CREATE TABLE public.trip_action_completions (
  action_id uuid NOT NULL REFERENCES public.trip_actions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action_id, user_id)
);
CREATE INDEX trip_action_completions_trip_id_idx ON public.trip_action_completions (trip_id);

-- RLS: mirrors the trip_checklists policy shape (see
-- 20260706153414_v2_additions.sql), wrapping auth.uid() in a select
-- subquery per the Supabase performance advisor.

ALTER TABLE public.trip_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view trip actions" ON public.trip_actions
  FOR SELECT USING (public.can_view_trip(trip_id, (select auth.uid())));

CREATE POLICY "Participants can create trip actions" ON public.trip_actions
  FOR INSERT WITH CHECK (
    (select auth.uid()) = created_by
    AND public.is_trip_participant(trip_id, (select auth.uid()))
  );

CREATE POLICY "Creator, assignee or organizer can update trip actions" ON public.trip_actions
  FOR UPDATE USING (
    (select auth.uid()) = created_by
    OR (select auth.uid()) = assigned_to
    OR public.is_trip_organizer(trip_id, (select auth.uid()))
  ) WITH CHECK (
    (select auth.uid()) = created_by
    OR (select auth.uid()) = assigned_to
    OR public.is_trip_organizer(trip_id, (select auth.uid()))
  );

CREATE POLICY "Creator or organizer can delete trip actions" ON public.trip_actions
  FOR DELETE USING (
    (select auth.uid()) = created_by
    OR public.is_trip_organizer(trip_id, (select auth.uid()))
  );

ALTER TABLE public.trip_action_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view trip action completions" ON public.trip_action_completions
  FOR SELECT USING (public.can_view_trip(trip_id, (select auth.uid())));

CREATE POLICY "Participants can record their own completion" ON public.trip_action_completions
  FOR INSERT WITH CHECK (
    (select auth.uid()) = user_id
    AND public.is_trip_participant(trip_id, (select auth.uid()))
  );

CREATE POLICY "Own completion or organizer can delete" ON public.trip_action_completions
  FOR DELETE USING (
    (select auth.uid()) = user_id
    OR public.is_trip_organizer(trip_id, (select auth.uid()))
  );

-- Realtime: full replica identity so DELETE payloads carry trip_id for the
-- trip-scoped postgres_changes filter (see
-- 20260718134402_replica_identity_full_for_realtime.sql), and register
-- both tables on the realtime publication. Guarded so re-running (or
-- running against a project where the tables/publication membership
-- already exist) doesn't fail.

ALTER TABLE public.trip_actions REPLICA IDENTITY FULL;
ALTER TABLE public.trip_action_completions REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trip_actions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_actions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trip_action_completions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trip_action_completions;
  END IF;
END;
$$;
