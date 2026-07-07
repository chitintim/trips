-- Decision shapes (UX_REDESIGN.md Part 5): planning_sections gains an
-- additive `metadata` jsonb column, mirroring the existing `options.metadata`
-- and `selections.metadata` columns. Runtime convention (see
-- src/features/decisions/lib/decisionShapes.ts):
--   { decision_shape?: 'vote' | 'personal' }
-- Absent/null metadata (or a missing decision_shape key) means 'vote' — the
-- existing group-poll behaviour — so every pre-existing section keeps working
-- unchanged with no backfill required.
ALTER TABLE planning_sections ADD COLUMN IF NOT EXISTS metadata jsonb;
