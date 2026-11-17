/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The build id injected by vite.config.ts (commit SHA, or 'dev'). Read it through src/lib/appVersion.ts. */
declare const __APP_BUILD__: string
