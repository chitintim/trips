-- Waitlist lifecycle: offer-with-expiry column (plan §14 waitlist lifecycle
-- + auto-FAQ; workstream C -- Lifecycle & decisions).
--
-- When a confirmed spot frees up (decline/cancel, or the organizer raises
-- capacity), the auto-chase engine offers it to the first waitlisted
-- participant with an expiry (default 48h). If unclaimed by the expiry, the
-- offer cascades to the next person in the waitlist queue. This column is
-- the state the UI reads/writes; the actual email send is the auto-chase
-- edge function's job (out of scope here).
--
-- ADDITIVE ONLY: single nullable column, no existing data touched.

ALTER TABLE "public"."trip_participants"
  ADD COLUMN IF NOT EXISTS "waitlist_offer_expires_at" timestamptz;

COMMENT ON COLUMN "public"."trip_participants"."waitlist_offer_expires_at" IS
  'Set when a freed spot is offered to a waitlisted participant (default 48h window). NULL means no pending offer. If the expiry passes without the participant confirming, the auto-chase engine (or a client-side sweep) clears this and cascades the offer to the next person in waitlist order. Read/written by the confirmations UI (workstream C) and the auto-chase edge function.';
