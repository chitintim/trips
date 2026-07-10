import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const dirname = fileURLToPath(new URL('.', import.meta.url))

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Style-grade rules kept visible but non-blocking (legacy any-casts on
      // avatar_data/metadata Json columns; empty compound-component props).
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
  {
    // Type-aware linting, scoped to the app source tree covered by
    // tsconfig.json (include: ["src"]). Deliberately a separate block from
    // the ts/tsx block above (rather than adding parserOptions.project
    // there) so files outside src/ that match **/*.{ts,tsx} — vite.config.ts,
    // playwright config, supabase/functions/** (Deno edge functions, not
    // part of this tsconfig project) — don't hit "file was not found in the
    // project" errors when someone runs `npm run lint` (whole repo) locally.
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: dirname,
      },
    },
    rules: {
      // Defense-in-depth against detached-method bugs: calling a method
      // torn off its object (e.g. `const rpc = supabase.rpc as unknown as
      // (...)`) loses its `this` binding and throws at call time. Bit
      // production twice from this exact supabase.rpc pattern (2026-07-10
      // incident). Verified against a repro of that pattern: this rule
      // flags it, and it adds zero new findings on the current codebase.
      '@typescript-eslint/unbound-method': 'error',
    },
  },
)
