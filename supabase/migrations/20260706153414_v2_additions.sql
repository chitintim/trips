-- v2 additions: places, bookings, decisions/voting, activity feed, AI platform
-- (rate limits + usage log + proposals/approval layer), settlement v2,
-- shares split type, checklists, settlement carryovers, auto-chase
-- notifications log.
--
-- ADDITIVE ONLY: no existing table/column/type is dropped, renamed, or
-- retyped. All new columns are nullable (or have a default) so existing
-- rows and application code keep working unmodified.
--
-- Per plan §3/§17. Mirrors existing per-trip RLS pattern using the existing
-- SECURITY DEFINER helpers is_trip_participant(trip_id, user_id),
-- is_trip_organizer(trip_id, user_id), can_view_trip(trip_id, user_id).

-- =========================================================================
-- 0. Enum additions (must run standalone -- new enum values cannot be used
--    in the same transaction they are added in on Postgres < 12 semantics;
--    the Supabase migration runner applies each migration file in its own
--    transaction, so we keep this at the very top of the file and do not
--    reference 'shares' anywhere else in this same file).
-- =========================================================================

ALTER TYPE "public"."split_type" ADD VALUE IF NOT EXISTS 'shares';

-- =========================================================================
-- 1. New columns on existing tables (all additive/nullable or defaulted)
-- =========================================================================

ALTER TABLE "public"."trips"
  ADD COLUMN IF NOT EXISTS "base_currency" "text" NOT NULL DEFAULT 'GBP',
  ADD COLUMN IF NOT EXISTS "chase_settings" jsonb;
COMMENT ON COLUMN "public"."trips"."base_currency" IS 'ISO 4217 settlement/display currency for this trip. Defaults to GBP to match pre-v2 behavior.';
COMMENT ON COLUMN "public"."trips"."chase_settings" IS 'Per-trip auto-chase engine configuration (which blockers to nudge for, cadence, channels).';

ALTER TABLE "public"."planning_sections"
  ADD COLUMN IF NOT EXISTS "vote_deadline" timestamptz,
  ADD COLUMN IF NOT EXISTS "quorum" integer,
  ADD COLUMN IF NOT EXISTS "voting_method" "text" NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS "hide_votes_until_close" boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN "public"."planning_sections"."voting_method" IS 'single | approval | ranked';

ALTER TABLE "public"."options"
  ADD COLUMN IF NOT EXISTS "place_id" "uuid";

ALTER TABLE "public"."trip_timeline_events"
  ADD COLUMN IF NOT EXISTS "place_id" "uuid";

ALTER TABLE "public"."expenses"
  ADD COLUMN IF NOT EXISTS "tip_amount" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "tax_lines" jsonb,
  ADD COLUMN IF NOT EXISTS "rounding_adjustment" numeric(10,2),
  ADD COLUMN IF NOT EXISTS "place_id" "uuid",
  ADD COLUMN IF NOT EXISTS "booking_id" "uuid",
  ADD COLUMN IF NOT EXISTS "rate_source" "text",
  ADD COLUMN IF NOT EXISTS "participant_ids" uuid[];
COMMENT ON COLUMN "public"."expenses"."tax_lines" IS 'v2 array of {rate, amount, inclusive} tax groups, replaces flat tax_amount/tax_percent as source of truth (old columns kept for compatibility)';
COMMENT ON COLUMN "public"."expenses"."rate_source" IS 'How fx_rate was determined: frankfurter | open_er_api | manual | same_currency';
COMMENT ON COLUMN "public"."expenses"."participant_ids" IS 'Who was present/involved in this expense (distinct from who it is split among) -- the auto-chase engine targets these users for related nudges.';

ALTER TABLE "public"."expense_splits"
  ADD COLUMN IF NOT EXISTS "shares" numeric(10,4);
COMMENT ON COLUMN "public"."expense_splits"."shares" IS 'Weight used when split_type = shares (e.g. couples count 2x). Nullable for pre-existing split types.';

ALTER TABLE "public"."settlements"
  ADD COLUMN IF NOT EXISTS "status" "text" NOT NULL DEFAULT 'confirmed',
  ADD COLUMN IF NOT EXISTS "currency" "text";
COMMENT ON COLUMN "public"."settlements"."status" IS 'suggested | marked_paid | confirmed. Defaults to confirmed so pre-v2 rows (recorded as already-settled) keep their existing meaning.';

ALTER TABLE "public"."users"
  ADD COLUMN IF NOT EXISTS "payment_details" jsonb,
  ADD COLUMN IF NOT EXISTS "email_notifications_enabled" boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN "public"."users"."payment_details" IS 'Free-form JSON of preferred payment rails: bank/PayNow/Revolut/Wise handle, free text.';
COMMENT ON COLUMN "public"."users"."email_notifications_enabled" IS 'Global opt-out for email notifications from the auto-chase engine. Defaults to true (matches current no-opt-out behavior).';

-- =========================================================================
-- 2. New tables
-- =========================================================================

-- places: a single location referenced by options/timeline events/expenses/bookings
CREATE TABLE IF NOT EXISTS "public"."places" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "lat" double precision,
  "lng" double precision,
  "google_place_url" text,
  "google_maps_link" text,
  "address" text,
  "source" text NOT NULL DEFAULT 'manual',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "places_name_length" CHECK (char_length("name") <= 200),
  CONSTRAINT "places_source_check" CHECK ("source" IN ('manual','link_parse','receipt','ai'))
);
CREATE INDEX IF NOT EXISTS "places_trip_id_idx" ON "public"."places" ("trip_id");

-- Now that places exists, add the FKs for the place_id columns added above.
ALTER TABLE "public"."options"
  ADD CONSTRAINT "options_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "options_place_id_idx" ON "public"."options" ("place_id");

ALTER TABLE "public"."trip_timeline_events"
  ADD CONSTRAINT "trip_timeline_events_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "trip_timeline_events_place_id_idx" ON "public"."trip_timeline_events" ("place_id");

-- bookings
CREATE TABLE IF NOT EXISTS "public"."bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "option_id" uuid REFERENCES "public"."options"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "vendor" text,
  "confirmation_ref" text,
  "booked_by" uuid NOT NULL REFERENCES "public"."users"("id"),
  "amount" numeric(10,2),
  "currency" text,
  "booking_date" date,
  "cancellation_deadline" timestamptz,
  "refundable" boolean DEFAULT false,
  "status" text NOT NULL DEFAULT 'reserved',
  "document_url" text,
  "expense_id" uuid REFERENCES "public"."expenses"("id") ON DELETE SET NULL,
  "timeline_event_id" uuid REFERENCES "public"."trip_timeline_events"("id") ON DELETE SET NULL,
  "place_id" uuid REFERENCES "public"."places"("id") ON DELETE SET NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bookings_title_length" CHECK (char_length("title") <= 200),
  CONSTRAINT "bookings_status_check" CHECK ("status" IN ('reserved','paid','cancelled'))
);
CREATE INDEX IF NOT EXISTS "bookings_trip_id_idx" ON "public"."bookings" ("trip_id");
CREATE INDEX IF NOT EXISTS "bookings_option_id_idx" ON "public"."bookings" ("option_id");
CREATE INDEX IF NOT EXISTS "bookings_expense_id_idx" ON "public"."bookings" ("expense_id");

-- Now that bookings exists, add the FK for expenses.booking_id added above.
ALTER TABLE "public"."expenses"
  ADD CONSTRAINT "expenses_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "expenses_booking_id_idx" ON "public"."expenses" ("booking_id");
CREATE INDEX IF NOT EXISTS "expenses_place_id_idx" ON "public"."expenses" ("place_id");
ALTER TABLE "public"."expenses"
  ADD CONSTRAINT "expenses_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE SET NULL;

-- option_votes: votes are the decision phase, separate from selections (the committed choice)
CREATE TABLE IF NOT EXISTS "public"."option_votes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "option_id" uuid NOT NULL REFERENCES "public"."options"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "rank" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "option_votes_unique" UNIQUE ("option_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "option_votes_option_id_idx" ON "public"."option_votes" ("option_id");
CREATE INDEX IF NOT EXISTS "option_votes_user_id_idx" ON "public"."option_votes" ("user_id");

-- reactions: emoji quick-reactions on options/comments
CREATE TABLE IF NOT EXISTS "public"."reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "option_id" uuid REFERENCES "public"."options"("id") ON DELETE CASCADE,
  "comment_id" uuid REFERENCES "public"."comments"("id") ON DELETE CASCADE,
  "emoji" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reactions_emoji_length" CHECK (char_length("emoji") <= 16),
  CONSTRAINT "reactions_target_check" CHECK (
    ("option_id" IS NOT NULL AND "comment_id" IS NULL)
    OR ("option_id" IS NULL AND "comment_id" IS NOT NULL)
  ),
  CONSTRAINT "reactions_unique" UNIQUE ("user_id", "option_id", "comment_id", "emoji")
);
CREATE INDEX IF NOT EXISTS "reactions_trip_id_idx" ON "public"."reactions" ("trip_id");
CREATE INDEX IF NOT EXISTS "reactions_option_id_idx" ON "public"."reactions" ("option_id");
CREATE INDEX IF NOT EXISTS "reactions_comment_id_idx" ON "public"."reactions" ("comment_id");

-- activity_feed: written by mutations, powers the per-trip activity feed
CREATE TABLE IF NOT EXISTS "public"."activity_feed" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "actor" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "verb" text NOT NULL,
  "entity" jsonb,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "activity_feed_trip_id_idx" ON "public"."activity_feed" ("trip_id");
CREATE INDEX IF NOT EXISTS "activity_feed_created_at_idx" ON "public"."activity_feed" ("trip_id", "created_at" DESC);

-- rate_limits: postgres token buckets for AI feature rate limiting
CREATE TABLE IF NOT EXISTS "public"."rate_limits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "feature" text NOT NULL,
  "tokens" numeric(10,4) NOT NULL,
  "last_refill" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rate_limits_unique" UNIQUE ("user_id", "feature")
);
CREATE INDEX IF NOT EXISTS "rate_limits_user_id_idx" ON "public"."rate_limits" ("user_id");

-- ai_usage: per-call cost/usage log for the admin spend dashboard + circuit breaker
CREATE TABLE IF NOT EXISTS "public"."ai_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "trip_id" uuid REFERENCES "public"."trips"("id") ON DELETE SET NULL,
  "function_name" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "cache_read_tokens" integer,
  "cache_write_tokens" integer,
  "estimated_cost_usd" numeric(10,6),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_usage_trip_id_idx" ON "public"."ai_usage" ("trip_id");
CREATE INDEX IF NOT EXISTS "ai_usage_user_id_idx" ON "public"."ai_usage" ("user_id");
CREATE INDEX IF NOT EXISTS "ai_usage_created_at_idx" ON "public"."ai_usage" ("created_at");

-- trip_checklists: lightweight shared checklist items ("who's bringing the speaker")
CREATE TABLE IF NOT EXISTS "public"."trip_checklists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "assigned_to" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "created_by" uuid NOT NULL REFERENCES "public"."users"("id"),
  "done" boolean NOT NULL DEFAULT false,
  "done_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "trip_checklists_title_length" CHECK (char_length("title") <= 300)
);
CREATE INDEX IF NOT EXISTS "trip_checklists_trip_id_idx" ON "public"."trip_checklists" ("trip_id");

-- settlement_carryovers: fold an unsettled balance from a previous completed
-- trip into this trip's settlement
CREATE TABLE IF NOT EXISTS "public"."settlement_carryovers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "source_trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "from_user_id" uuid NOT NULL REFERENCES "public"."users"("id"),
  "to_user_id" uuid NOT NULL REFERENCES "public"."users"("id"),
  "amount" numeric(10,2) NOT NULL,
  "currency" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "public"."users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "settlement_carryovers_different_users" CHECK ("from_user_id" <> "to_user_id"),
  CONSTRAINT "settlement_carryovers_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "settlement_carryovers_different_trips" CHECK ("trip_id" <> "source_trip_id")
);
CREATE INDEX IF NOT EXISTS "settlement_carryovers_trip_id_idx" ON "public"."settlement_carryovers" ("trip_id");
CREATE INDEX IF NOT EXISTS "settlement_carryovers_source_trip_id_idx" ON "public"."settlement_carryovers" ("source_trip_id");

-- ai_proposals: AI proposals & human approval layer (plan §13). AI-drafted
-- batches of actions (from chat/ingest) that a human must review before
-- anything is applied -- the apply step runs under the approving user's own
-- JWT/RLS, so this table itself grants no special write privileges.
CREATE TABLE IF NOT EXISTS "public"."ai_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "created_by" uuid NOT NULL REFERENCES "public"."users"("id"),
  "source_text" text,
  "actions" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "reviewed_by" uuid REFERENCES "public"."users"("id"),
  "applied_at" timestamptz,
  "expires_at" timestamptz DEFAULT (now() + interval '7 days'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_proposals_status_check" CHECK ("status" IN ('pending','approved','rejected','partially_applied'))
);
CREATE INDEX IF NOT EXISTS "ai_proposals_trip_id_idx" ON "public"."ai_proposals" ("trip_id");

-- notifications: sent-notification log for the auto-chase engine (plan §14).
-- Written exclusively by the service role (edge function/cron) -- there is
-- no user insert policy -- so a dedupe_key unique constraint plus this being
-- server-only is what prevents duplicate chases.
CREATE TABLE IF NOT EXISTS "public"."notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id" uuid NOT NULL REFERENCES "public"."trips"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "entity_type" text,
  "entity_id" uuid,
  "channel" text NOT NULL DEFAULT 'email',
  "dedupe_key" text NOT NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notifications_dedupe_key_unique" UNIQUE ("dedupe_key")
);
CREATE INDEX IF NOT EXISTS "notifications_trip_user_sent_idx" ON "public"."notifications" ("trip_id", "user_id", "sent_at");

-- =========================================================================
-- 3. RLS: enable + policies mirroring the existing per-trip pattern
-- =========================================================================

-- places: participants can read/manage, organizers manage
ALTER TABLE "public"."places" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view places" ON "public"."places"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Participants can create places" ON "public"."places"
  FOR INSERT WITH CHECK (public.is_trip_participant(trip_id, auth.uid()));

CREATE POLICY "Organizers can update places" ON "public"."places"
  FOR UPDATE USING (public.is_trip_organizer(trip_id, auth.uid()))
  WITH CHECK (public.is_trip_organizer(trip_id, auth.uid()));

CREATE POLICY "Organizers can delete places" ON "public"."places"
  FOR DELETE USING (public.is_trip_organizer(trip_id, auth.uid()));

-- bookings: participants read, organizers manage
ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view bookings" ON "public"."bookings"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Organizers can create bookings" ON "public"."bookings"
  FOR INSERT WITH CHECK (public.is_trip_organizer(trip_id, auth.uid()));

CREATE POLICY "Organizers can update bookings" ON "public"."bookings"
  FOR UPDATE USING (public.is_trip_organizer(trip_id, auth.uid()))
  WITH CHECK (public.is_trip_organizer(trip_id, auth.uid()));

CREATE POLICY "Organizers can delete bookings" ON "public"."bookings"
  FOR DELETE USING (public.is_trip_organizer(trip_id, auth.uid()));

-- option_votes: participants read (subject to app-level hide_votes_until_close
-- enforcement -- RLS grants row access, the app hides vote details in the UI
-- pre-close since the "who voted for what" reveal is a UX policy, not a
-- security boundary within a trip), participants insert/update their own vote
ALTER TABLE "public"."option_votes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view votes" ON "public"."option_votes"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.options o
      WHERE o.id = option_votes.option_id
        AND public.is_trip_participant((SELECT ps.trip_id FROM public.planning_sections ps WHERE ps.id = o.section_id), auth.uid())
    )
  );

CREATE POLICY "Participants can cast their own vote" ON "public"."option_votes"
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.options o
      WHERE o.id = option_votes.option_id
        AND public.is_trip_participant((SELECT ps.trip_id FROM public.planning_sections ps WHERE ps.id = o.section_id), auth.uid())
    )
  );

CREATE POLICY "Participants can update their own vote" ON "public"."option_votes"
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Participants can delete their own vote" ON "public"."option_votes"
  FOR DELETE USING (auth.uid() = user_id);

-- reactions: participants read, participants insert their own, delete their own
ALTER TABLE "public"."reactions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view reactions" ON "public"."reactions"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Participants can create their own reactions" ON "public"."reactions"
  FOR INSERT WITH CHECK (auth.uid() = user_id AND public.is_trip_participant(trip_id, auth.uid()));

CREATE POLICY "Users can delete their own reactions" ON "public"."reactions"
  FOR DELETE USING (auth.uid() = user_id);

-- activity_feed: participants read; written by the app (service role for
-- system-authored entries) or by participants for their own actor rows
ALTER TABLE "public"."activity_feed" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view activity feed" ON "public"."activity_feed"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Participants can write their own activity" ON "public"."activity_feed"
  FOR INSERT WITH CHECK (
    public.is_trip_participant(trip_id, auth.uid())
    AND (actor IS NULL OR actor = auth.uid())
  );

-- rate_limits: no direct user policies -- accessed only via the
-- consume_rate_limit() SECURITY DEFINER RPC below, or the service role.
ALTER TABLE "public"."rate_limits" ENABLE ROW LEVEL SECURITY;

-- ai_usage: users may read their own usage rows; all writes go through the
-- service role (edge functions), never directly from clients.
ALTER TABLE "public"."ai_usage" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own ai usage" ON "public"."ai_usage"
  FOR SELECT USING (auth.uid() = user_id);

-- trip_checklists: participants read, participants insert/manage their own
-- items, organizers manage all
ALTER TABLE "public"."trip_checklists" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view checklist items" ON "public"."trip_checklists"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Participants can create checklist items" ON "public"."trip_checklists"
  FOR INSERT WITH CHECK (auth.uid() = created_by AND public.is_trip_participant(trip_id, auth.uid()));

CREATE POLICY "Creator, assignee or organizer can update checklist items" ON "public"."trip_checklists"
  FOR UPDATE USING (
    auth.uid() = created_by
    OR auth.uid() = assigned_to
    OR public.is_trip_organizer(trip_id, auth.uid())
  ) WITH CHECK (
    auth.uid() = created_by
    OR auth.uid() = assigned_to
    OR public.is_trip_organizer(trip_id, auth.uid())
  );

CREATE POLICY "Creator or organizer can delete checklist items" ON "public"."trip_checklists"
  FOR DELETE USING (
    auth.uid() = created_by
    OR public.is_trip_organizer(trip_id, auth.uid())
  );

-- settlement_carryovers: participants of the destination trip can read,
-- organizers of the destination trip manage (creating a carryover requires
-- being an organizer of the trip it's being folded INTO)
ALTER TABLE "public"."settlement_carryovers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view settlement carryovers" ON "public"."settlement_carryovers"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Organizers can create settlement carryovers" ON "public"."settlement_carryovers"
  FOR INSERT WITH CHECK (
    public.is_trip_organizer(trip_id, auth.uid())
    AND auth.uid() = created_by
  );

CREATE POLICY "Organizers can delete settlement carryovers" ON "public"."settlement_carryovers"
  FOR DELETE USING (public.is_trip_organizer(trip_id, auth.uid()));

-- ai_proposals: participants read, participants create their own, organizers
-- (and the original creator) can update status fields (approve/reject).
-- Applying an approved proposal's actions happens through the normal
-- per-table RLS under the approving user's own JWT -- this table only
-- gates the review workflow, not the underlying writes.
ALTER TABLE "public"."ai_proposals" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Participants can view ai proposals" ON "public"."ai_proposals"
  FOR SELECT USING (public.can_view_trip(trip_id, auth.uid()));

CREATE POLICY "Participants can create their own ai proposals" ON "public"."ai_proposals"
  FOR INSERT WITH CHECK (
    auth.uid() = created_by
    AND public.is_trip_participant(trip_id, auth.uid())
  );

CREATE POLICY "Creator or organizer can update ai proposal status" ON "public"."ai_proposals"
  FOR UPDATE USING (
    auth.uid() = created_by
    OR public.is_trip_organizer(trip_id, auth.uid())
  ) WITH CHECK (
    auth.uid() = created_by
    OR public.is_trip_organizer(trip_id, auth.uid())
  );

-- notifications: users can see their own; organizers can see all notifications
-- for their trip (to audit what the chase engine has sent). No insert/update/
-- delete policies for regular users -- writes happen only via the service
-- role, which bypasses RLS entirely.
ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own notifications" ON "public"."notifications"
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Organizers can view all trip notifications" ON "public"."notifications"
  FOR SELECT USING (public.is_trip_organizer(trip_id, auth.uid()));

-- =========================================================================
-- 4. consume_rate_limit RPC: atomic token-bucket check-and-decrement
-- =========================================================================

CREATE OR REPLACE FUNCTION "public"."consume_rate_limit"(
  "p_feature" text,
  "p_capacity" integer,
  "p_refill_per_day" integer
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_row public.rate_limits%ROWTYPE;
  v_elapsed_days double precision;
  v_refilled_tokens numeric;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'consume_rate_limit requires an authenticated user';
  END IF;

  -- Lock (or create) this user+feature's bucket row for the duration of the
  -- transaction so concurrent requests serialize instead of racing.
  INSERT INTO public.rate_limits (user_id, feature, tokens, last_refill)
  VALUES (v_user_id, p_feature, p_capacity, v_now)
  ON CONFLICT (user_id, feature) DO NOTHING;

  SELECT * INTO v_row
  FROM public.rate_limits
  WHERE user_id = v_user_id AND feature = p_feature
  FOR UPDATE;

  -- Refill proportionally to elapsed time since last refill, capped at capacity.
  v_elapsed_days := GREATEST(EXTRACT(EPOCH FROM (v_now - v_row.last_refill)) / 86400.0, 0);
  v_refilled_tokens := LEAST(p_capacity, v_row.tokens + v_elapsed_days * p_refill_per_day);

  IF v_refilled_tokens < 1 THEN
    -- Not enough tokens: persist the refill amount (so partial refill isn't
    -- lost) but do not consume, and report failure.
    UPDATE public.rate_limits
    SET tokens = v_refilled_tokens, last_refill = v_now
    WHERE user_id = v_user_id AND feature = p_feature;
    RETURN false;
  END IF;

  UPDATE public.rate_limits
  SET tokens = v_refilled_tokens - 1, last_refill = v_now
  WHERE user_id = v_user_id AND feature = p_feature;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION "public"."consume_rate_limit"(text, integer, integer) IS
  'Atomic token-bucket check-and-decrement keyed on (auth.uid(), feature). Returns true if a token was consumed, false if the bucket was empty. Call once per AI feature invocation before doing the expensive work.';

-- =========================================================================
-- 5. Split-sum validation trigger -- SKIPPED, see note.
-- =========================================================================
--
-- The plan asks for a DEFERRABLE constraint trigger validating
-- SUM(expense_splits.amount) = expenses.amount (±0.05) for the affected
-- expense, scoped to "new" rows only to avoid breaking legacy data.
--
-- This is deliberately NOT implemented as a DB trigger in this migration:
--   - expenses has no reliable "created after v2 deploy" marker today (the
--     plan suggests adding an `expenses.v2 boolean` column, but that is a
--     schema decision with product implications -- e.g. do manually-added
--     legacy-shaped expenses after deploy count as v2? -- that belongs in
--     the expenses workstream (D), not foundation, and adding it here
--     speculatively risks a column nobody else's code expects).
--   - expense_splits are typically inserted row-by-row from the client
--     (see AddExpenseModal), so mid-transaction states (some but not all
--     splits inserted for a new expense) would spuriously fail a naive
--     per-row constraint trigger even with DEFERRABLE INITIALLY DEFERRED,
--     unless every call site is audited to ensure all splits for an
--     expense are inserted inside one transaction. That audit is out of
--     scope for the foundation workstream.
--   - The money module (src/lib/money) added in this workstream gives
--     workstream D an exact, tested largestRemainderDistribute() primitive
--     that guarantees split sums equal the total by construction, which is
--     a stronger guarantee than a tolerance-based DB trigger and is the
--     recommended enforcement point per plan §4 ("No floating-point
--     splits anywhere else").
--
-- Recommendation for workstream D/H: once all split-writing call sites are
-- audited and batched into a single transaction per expense, add a
-- DEFERRABLE CONSTRAINT TRIGGER in a follow-up migration, scoped with
-- `WHERE expenses.created_at > '<this deploy timestamp>'` instead of a new
-- column, which achieves the same "don't break legacy data" goal without a
-- schema change.
