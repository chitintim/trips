-- One-off data correction: fix a participant mix-up on the "Sailing Sicily"
-- trip (id 46efa496-11b6-49c8-b229-c72161f59126). The organizer added the
-- wrong two people while setting up the trip and asked (both directly, and
-- via the in-app trip chat on 2026-07-10: "can you remove Marvin and Sammy?
-- It's supposed to be Marj and Salim") to correct it.
--
-- Investigation confirmed this is a genuine participant swap, not a
-- placeholder-account rename:
--   - Marvin Hui (37acd741-7c79-4032-9da2-5e5fb97209bc) and
--     Sammy Yip (882c1d05-6ba8-4637-b682-b719ca2299fd) are real, established
--     accounts with their own emails, and Marvin has extensive unrelated
--     activity (expenses, expense splits, invitation history, settlements)
--     on a separate trip (2fd90a5f-f870-435e-b19f-ea30f1b54eff). Renaming
--     either account would incorrectly relabel a real, unrelated person
--     everywhere they appear.
--   - Salim Ata (f5ff519e-cb5b-4413-9802-ed01a17d0bce) and
--     Marj Ding (df93ecf8-5b98-41bc-b9e2-5cdf0cf2acc2) already exist as
--     distinct real accounts too (also active on that same other trip), so
--     no new user needs to be created or invited.
--
-- Effect: on the Sailing Sicily trip only, remove Marvin Hui and Sammy Yip
-- from trip_participants and add Salim Ata and Marj Ding as participants
-- (matching the 'participant' role / 'pending' confirmation state the two
-- removed rows had). No other trip's data is touched. Idempotent: safe to
-- re-run (delete of already-absent rows is a no-op; insert is deduped via
-- the trip_participants (trip_id, user_id) primary key).

DELETE FROM public.trip_participants
WHERE trip_id = '46efa496-11b6-49c8-b229-c72161f59126'
  AND user_id IN (
    '37acd741-7c79-4032-9da2-5e5fb97209bc', -- Marvin Hui
    '882c1d05-6ba8-4637-b682-b719ca2299fd'  -- Sammy Yip
  );

INSERT INTO public.trip_participants (trip_id, user_id, role, confirmation_status, conditional_type, active)
VALUES
  ('46efa496-11b6-49c8-b229-c72161f59126', 'f5ff519e-cb5b-4413-9802-ed01a17d0bce', 'participant', 'pending', 'none', true), -- Salim Ata
  ('46efa496-11b6-49c8-b229-c72161f59126', 'df93ecf8-5b98-41bc-b9e2-5cdf0cf2acc2', 'participant', 'pending', 'none', true)  -- Marj Ding
ON CONFLICT (trip_id, user_id) DO NOTHING;
