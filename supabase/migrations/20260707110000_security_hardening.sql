-- Security hardening from SECURITY_AUDIT.md (v2 QA gate).
-- Additive/defensive only: immutable-column triggers fire solely on column
-- CHANGES no legitimate app flow performs, so existing behavior is unaffected.

-- ---------------------------------------------------------------------------
-- 1. Privilege-escalation guards (audit M-3 highest-value subset)
-- ---------------------------------------------------------------------------

-- users.role may only be changed by an admin.
CREATE OR REPLACE FUNCTION public.guard_user_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'::public.user_role
    ) THEN
      RAISE EXCEPTION 'Only admins may change user roles';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_guard_user_role_change ON public.users;
CREATE TRIGGER trigger_guard_user_role_change
  BEFORE UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.guard_user_role_change();

-- trip_participants.role may only be changed by a trip organizer or admin.
CREATE OR REPLACE FUNCTION public.guard_participant_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT (
      public.is_trip_organizer(NEW.trip_id, auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND role = 'admin'::public.user_role
      )
    ) THEN
      RAISE EXCEPTION 'Only trip organizers may change participant roles';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_guard_participant_role_change ON public.trip_participants;
CREATE TRIGGER trigger_guard_participant_role_change
  BEFORE UPDATE OF role ON public.trip_participants
  FOR EACH ROW EXECUTE FUNCTION public.guard_participant_role_change();

-- ---------------------------------------------------------------------------
-- 2. Immutable-key guards: rows can never be re-pointed across trips/users
--    by an UPDATE that passed a USING clause lacking WITH CHECK (audit M-3).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_immutable_keys()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    IF NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
      RAISE EXCEPTION 'expenses.trip_id is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'expense_splits' THEN
    IF NEW.expense_id IS DISTINCT FROM OLD.expense_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'expense_splits keys are immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'settlements' THEN
    IF NEW.trip_id IS DISTINCT FROM OLD.trip_id
       OR NEW.from_user_id IS DISTINCT FROM OLD.from_user_id
       OR NEW.to_user_id IS DISTINCT FROM OLD.to_user_id THEN
      RAISE EXCEPTION 'settlements keys are immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'trips' THEN
    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'trips.created_by is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'trip_participants' THEN
    IF NEW.trip_id IS DISTINCT FROM OLD.trip_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'trip_participants keys are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_guard_immutable_keys ON public.expenses;
CREATE TRIGGER trigger_guard_immutable_keys
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_keys();

DROP TRIGGER IF EXISTS trigger_guard_immutable_keys ON public.expense_splits;
CREATE TRIGGER trigger_guard_immutable_keys
  BEFORE UPDATE ON public.expense_splits
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_keys();

DROP TRIGGER IF EXISTS trigger_guard_immutable_keys ON public.settlements;
CREATE TRIGGER trigger_guard_immutable_keys
  BEFORE UPDATE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_keys();

DROP TRIGGER IF EXISTS trigger_guard_immutable_keys ON public.trips;
CREATE TRIGGER trigger_guard_immutable_keys
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_keys();

DROP TRIGGER IF EXISTS trigger_guard_immutable_keys ON public.trip_participants;
CREATE TRIGGER trigger_guard_immutable_keys
  BEFORE UPDATE ON public.trip_participants
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_keys();

-- ---------------------------------------------------------------------------
-- 3. Invitations: stop anonymous table-wide reads (audit M-2).
--    Signup validates codes via this narrow SECURITY DEFINER RPC instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_invitation_code(p_code text)
RETURNS TABLE (
  invitation_id uuid,
  is_valid boolean,
  reason text,
  trip_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.invitations WHERE code = upper(p_code);

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, false, 'not_found'::text, NULL::uuid;
  ELSIF v_inv.used_by IS NOT NULL THEN
    RETURN QUERY SELECT v_inv.id, false, 'already_used'::text, NULL::uuid;
  ELSIF v_inv.expires_at IS NOT NULL AND v_inv.expires_at < now() THEN
    RETURN QUERY SELECT v_inv.id, false, 'expired'::text, NULL::uuid;
  ELSE
    RETURN QUERY SELECT v_inv.id, true, 'valid'::text, v_inv.trip_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.validate_invitation_code(text) TO anon, authenticated;

-- Remove the anonymous-read branch: admins keep full SELECT; everyone else
-- goes through validate_invitation_code().
DROP POLICY IF EXISTS "Read invitations policy" ON public.invitations;
CREATE POLICY "Admins can read invitations" ON public.invitations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid() AND users.role = 'admin'::public.user_role
    )
  );

-- ---------------------------------------------------------------------------
-- 4. settlement_carryovers: creator must also be able to view the SOURCE trip
--    (audit M-5).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Organizers can create settlement carryovers" ON public.settlement_carryovers;
CREATE POLICY "Organizers can create settlement carryovers" ON public.settlement_carryovers
  FOR INSERT WITH CHECK (
    public.is_trip_organizer(trip_id, auth.uid())
    AND auth.uid() = created_by
    AND public.can_view_trip(source_trip_id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 5. fx_rates sanity constraints (audit M-4, partial: write path unchanged so
--    the client cache keeps working; poisoned values are bounded and the
--    nightly job re-derives official rates).
-- ---------------------------------------------------------------------------
ALTER TABLE public.fx_rates DROP CONSTRAINT IF EXISTS fx_rates_rate_positive;
ALTER TABLE public.fx_rates ADD CONSTRAINT fx_rates_rate_positive CHECK (rate > 0);
