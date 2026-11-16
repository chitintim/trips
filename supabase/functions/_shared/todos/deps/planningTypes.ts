/** Edge-only stand-in for `OptionVote` (an `option_votes` row) in src/lib/queries/usePlanning.ts. */
export interface OptionVote {
  created_at: string
  id: string
  option_id: string
  rank: number | null
  user_id: string
}
