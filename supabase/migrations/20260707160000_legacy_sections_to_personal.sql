-- One-off data migration: annotate pre-v3 planning sections with the decision
-- shape their data actually represents, so the unified Plan board renders
-- legacy trips natively (user request: migrate the data once, don't carry a
-- legacy-awareness heuristic in the composition layer forever).
--
-- Rationale: v1 participation was `selections` = "I'm in for this option"
-- (opt-in semantics: chalet, restaurant evenings, per-person ski packages).
-- That is exactly v3's decision_shape='personal' (personal picks / order
-- form). v3-era vote sections use `option_votes`, which no legacy section
-- has. Purely additive: only stamps jsonb metadata on sections that
--   1. have no explicit decision_shape yet,
--   2. have zero option_votes anywhere under them (not a v3 poll),
--   3. have at least one legacy selection (participation happened v1-style).
-- Sections matching none of these (e.g. fresh starter questions) are
-- untouched and keep their default 'vote' behavior. Idempotent.

UPDATE public.planning_sections s
SET metadata = COALESCE(s.metadata, '{}'::jsonb)
             || '{"decision_shape": "personal", "legacy_migrated": true}'::jsonb
WHERE (s.metadata ->> 'decision_shape') IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.option_votes v
    JOIN public.options o ON o.id = v.option_id
    WHERE o.section_id = s.id
  )
  AND EXISTS (
    SELECT 1
    FROM public.selections sel
    JOIN public.options o ON o.id = sel.option_id
    WHERE o.section_id = s.id
  );
