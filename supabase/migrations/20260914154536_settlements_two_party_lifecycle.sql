-- Settle Up: let the payer and payee actually act on their own settlement
-- row (previously only the original freezer, and only within 24h, could
-- update/delete -- the payer's "Mark paid" and payee's "Confirm received"
-- silently no-op'd under RLS). Also adds an organizer-scoped, suggested-only
-- delete bypass so refreeze cleanup works reliably, and a status CHECK that
-- was missing entirely. See the settle-up bug list this migration fixes:
-- payer/payee RLS deadlock, refreeze duplicate-suggestion cleanup, and the
-- unconstrained status column.

-- 1) UPDATE policy: creator (within 24h), trip organizer, OR the payer/
--    payee acting on their own settlement row. Column-level restriction on
--    what payer/payee may actually change is enforced by the trigger below
--    -- this policy is intentionally row-level only.
DROP POLICY IF EXISTS "Creator can update settlement within 24 hours" ON public.settlements;

CREATE POLICY "Creator, organizer, payer or payee can update settlement" ON public.settlements
  FOR UPDATE TO authenticated
  USING (
    (created_by = auth.uid() AND created_at > now() - interval '24 hours')
    OR public.is_trip_organizer(trip_id, auth.uid())
    OR from_user_id = auth.uid()
    OR to_user_id = auth.uid()
  )
  WITH CHECK (
    (created_by = auth.uid() AND created_at > now() - interval '24 hours')
    OR public.is_trip_organizer(trip_id, auth.uid())
    OR from_user_id = auth.uid()
    OR to_user_id = auth.uid()
  );

-- 2) DELETE policy: add an organizer bypass SCOPED TO status='suggested'
--    only (never marked_paid/confirmed -- those are payment history and
--    must never be deletable by this new bypass), so refreeze's stale-
--    suggested cleanup (SettleUpTab.tsx handleFreeze) doesn't silently
--    no-op once >24h have passed since the original freeze or when a
--    different organizer refreezes. Creator/admin's pre-existing (already
--    broader) delete power is left exactly as it was.
DROP POLICY IF EXISTS "Creator or admin can delete settlement within 24 hours" ON public.settlements;

CREATE POLICY "Creator, organizer or admin can delete settlement" ON public.settlements
  FOR DELETE TO authenticated
  USING (
    (created_by = auth.uid() AND created_at > now() - interval '24 hours')
    OR (public.is_trip_organizer(trip_id, auth.uid()) AND status = 'suggested')
    OR EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

-- 3) Trigger: restricts what a NON-creator/NON-organizer payer/payee may
--    actually change under the widened UPDATE policy above. Creator-
--    within-24h and organizers keep unrestricted edit rights (unchanged
--    behavior). This is what actually enforces "payer can only mark their
--    own suggested row paid, and set method/date/note; payee can only flip
--    marked_paid -> confirmed, nothing else."
CREATE OR REPLACE FUNCTION public.guard_settlement_party_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_privileged boolean;
BEGIN
  is_privileged := (OLD.created_by = auth.uid() AND OLD.created_at > now() - interval '24 hours')
                    OR public.is_trip_organizer(OLD.trip_id, auth.uid());
  IF is_privileged THEN RETURN NEW; END IF;

  -- A non-privileged payer/payee must never be able to rewrite who created
  -- this row or when: doing so would make them "privileged" (creator-
  -- within-24h) on their very next update, at which point this trigger
  -- applies zero restrictions and the DELETE policy's creator-within-24h
  -- bypass has no status scoping -- i.e. self-escalation into the power to
  -- delete or arbitrarily rewrite their own (possibly already-confirmed)
  -- settlement row. Block it for both branches below in one place.
  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'May not change who created this settlement or when';
  END IF;

  IF auth.uid() = OLD.from_user_id THEN
    IF OLD.status IS DISTINCT FROM 'suggested' OR NEW.status IS DISTINCT FROM 'marked_paid' THEN
      RAISE EXCEPTION 'Payer may only mark a suggested settlement as paid';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'Payer may not change the settlement amount or currency';
    END IF;
    RETURN NEW;
  ELSIF auth.uid() = OLD.to_user_id THEN
    IF OLD.status IS DISTINCT FROM 'marked_paid' OR NEW.status IS DISTINCT FROM 'confirmed' THEN
      RAISE EXCEPTION 'Payee may only confirm a settlement already marked paid';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
      RAISE EXCEPTION 'Confirming may not change the payer''s recorded payment details';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Not permitted to update this settlement'; -- unreachable given USING above; fail closed
END;
$$;

DROP TRIGGER IF EXISTS trigger_guard_settlement_party_update ON public.settlements;
CREATE TRIGGER trigger_guard_settlement_party_update
  BEFORE UPDATE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION public.guard_settlement_party_update();

-- 4) status CHECK constraint -- the column previously accepted any string.
--    Before applying to production, verify with
--    `SELECT DISTINCT status FROM settlements;` that only the three known
--    values exist -- abort and report back if not.
ALTER TABLE public.settlements
  ADD CONSTRAINT settlements_status_check CHECK (status IN ('suggested', 'marked_paid', 'confirmed'));
