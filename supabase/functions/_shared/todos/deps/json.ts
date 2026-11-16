/** Edge-only stand-in for `Json` from src/types/database.types.ts (the engine only needs the type). */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]
