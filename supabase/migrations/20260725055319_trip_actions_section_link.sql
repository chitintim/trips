-- Link trip_actions to an open decision (planning_sections) so "go vote on
-- this" actions can derive their completion from the user's actual vote
-- instead of relying solely on a manual tick. Nullable/optional — actions
-- with no section_id keep exactly today's manual-completion behaviour (see
-- src/features/actions/lib/actionStatus.ts). ON DELETE SET NULL: deleting
-- the section shouldn't delete the action, just drop the (now meaningless)
-- link.
ALTER TABLE public.trip_actions
  ADD COLUMN IF NOT EXISTS section_id uuid REFERENCES public.planning_sections(id) ON DELETE SET NULL;

-- Supports the create/edit form's reverse lookup (does this section already
-- have a linked action?) and any future per-section action listing.
CREATE INDEX IF NOT EXISTS trip_actions_section_id_idx ON public.trip_actions (section_id);
