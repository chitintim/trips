-- settlement_carryovers de-dupe: a specific unpaid debt from a source trip
-- (source_trip_id, from_user_id -> to_user_id) must be foldable into a
-- settlement AT MOST ONCE, full stop -- never into two different target
-- trips, and never twice via a double-clicked "Fold in" button. The app
-- layer (useCarryoverCandidates) already nets out already-folded amounts
-- before offering a candidate, but that check can only see carryover rows
-- whose target trip the current user still has RLS visibility into (the
-- carryover's own SELECT policy is scoped by trip_id, not source_trip_id) --
-- so it cannot fully guard against a debt already folded into a trip the
-- user has since left. This unique index is DB-enforced and closes that
-- gap regardless of RLS visibility, and also closes the double-click race
-- (two near-simultaneous inserts for the exact same pair).
CREATE UNIQUE INDEX IF NOT EXISTS "settlement_carryovers_source_pair_unique_idx"
  ON "public"."settlement_carryovers" ("source_trip_id", "from_user_id", "to_user_id");
