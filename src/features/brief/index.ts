/**
 * Public surface of the brief feature. v2.1: the Brief TAB is gone — its
 * content is absorbed into Today's stage layouts (UX_REDESIGN.md Part 2), so
 * this barrel now exports the decomposed brief SECTIONS plus the data hook,
 * and no tab config.
 */
export {
  BriefCover,
  OrganizerMessageCard,
  WhosInRow,
} from './components/BriefSections'
export { useBriefData } from './lib/useBriefData'
export type { BriefData } from './lib/useBriefData'
