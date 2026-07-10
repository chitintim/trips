// Test-only fallbacks so unit tests are hermetic and don't require a local
// .env file (every fresh git worktree / clone / CI run without secrets
// would otherwise fail 3 suites that transitively import src/lib/supabase.ts,
// which throws at module load if these are missing). Only applies when the
// vars are genuinely unset, so a real local .env still takes precedence.
// This does NOT touch the production runtime guard in src/lib/supabase.ts —
// the app still fails loudly on genuine misconfiguration outside tests.
process.env.VITE_SUPABASE_URL ??= 'https://test.invalid.supabase.co'
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-anon-key-not-real'
