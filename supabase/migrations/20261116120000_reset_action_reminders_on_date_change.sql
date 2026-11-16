-- Make the staged action-deadline reminder ladder aware of due-date changes.
--
-- Problem: trip_action_reminders is keyed (action_id, user_id, stage), so once
-- d7/d1/overdue fired for an action they never fired again -- even after the
-- organiser pushed the deadline back (or moved the trip dates for a
-- "before trip" action), and the people were never reminded about the NEW date.
--
-- Fix (additive, no change to the table or its primary key): whenever an
-- action's effective due date really changes, forget what we already sent for
-- that action so the ladder restarts against the new date. Deliberately NOT a
-- schema change to the key:
--   * old and new auto-chase code both keep working in either deploy order
--     (the function's upsert onConflict 'action_id,user_id,stage' stays valid);
--   * existing rows are untouched, so deploying this re-sends nothing --
--     a row is only deleted when a date is actually edited afterwards, and
--     the triggers compare OLD vs NEW with IS DISTINCT FROM so no-op updates
--     (same value written again) do not clear anything.
--
-- Triggers are SECURITY DEFINER because trip_action_reminders has no
-- INSERT/UPDATE/DELETE policies (service role only) while the editing user is
-- an ordinary participant/organiser.

CREATE OR REPLACE FUNCTION public.reset_action_reminders_on_action_due_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.deadline_kind IS DISTINCT FROM OLD.deadline_kind THEN
    DELETE FROM public.trip_action_reminders WHERE action_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_action_reminders_on_action_due_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reset_action_reminders_on_due_change ON public.trip_actions;
CREATE TRIGGER trg_reset_action_reminders_on_due_change
  AFTER UPDATE OF due_date, deadline_kind ON public.trip_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_action_reminders_on_action_due_change();

-- "Before trip" actions take their due date from trips.start_date.
CREATE OR REPLACE FUNCTION public.reset_action_reminders_on_trip_start_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    DELETE FROM public.trip_action_reminders r
    USING public.trip_actions a
    WHERE r.action_id = a.id
      AND a.trip_id = NEW.id
      AND a.deadline_kind = 'before_trip';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_action_reminders_on_trip_start_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reset_action_reminders_on_trip_start_change ON public.trips;
CREATE TRIGGER trg_reset_action_reminders_on_trip_start_change
  AFTER UPDATE OF start_date ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.reset_action_reminders_on_trip_start_change();
