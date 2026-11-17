import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Base path is configurable via VITE_BASE so a future move off GitHub
// Pages (served under /trips/) to trips.fontem.ai (served from /) is a
// one-line env flip. Defaults to today's /trips/ so a build with no
// VITE_BASE set is byte-identical to before this became configurable.
const base = process.env.VITE_BASE ?? '/trips/'

// public/manifest.webmanifest and public/sw.js are copied by Vite's static
// public/ passthrough verbatim (unlike index.html, which supports the
// %BASE_URL% placeholder) — they hardcode /trips/ throughout. This plugin
// rewrites those two files in dist/ after the build to the resolved base.
// When base is the default /trips/, the replacement is a no-op (same
// string in, same string out).
function rewriteBaseInStaticFiles() {
  return {
    name: 'rewrite-base-in-static-files',
    writeBundle() {
      for (const file of ['manifest.webmanifest', 'sw.js']) {
        const path = resolve(process.cwd(), 'dist', file)
        const contents = readFileSync(path, 'utf-8')
        const rewritten = contents.split('/trips/').join(base)
        if (rewritten !== contents) writeFileSync(path, rewritten)
      }
    },
  }
}

// The build id the running app reports (X-Client-Info: trips-web/<id>, see src/lib/appVersion.ts) and
// that dist/version.json carries so an open tab can tell a newer deploy exists. deploy.yml passes the
// commit SHA as VITE_APP_BUILD; locally it falls back to the checked-out commit, then to 'dev'.
function resolveBuildId(): string {
  const fromEnv = (process.env.VITE_APP_BUILD || process.env.GITHUB_SHA || '').trim()
  if (fromEnv) return fromEnv.slice(0, 12)
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}
const buildId = resolveBuildId()
const builtAt = new Date().toISOString()

// Emits dist/version.json ({build, builtAt}). It is a plain static file: public/sw.js caches nothing and
// ignores GET, so nothing stands between the app's no-store fetch and the host.
function emitVersionJson() {
  return {
    name: 'emit-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId, builtAt }) + '\n' })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), rewriteBaseInStaticFiles(), emitVersionJson()],
  base,
  define: {
    __APP_BUILD__: JSON.stringify(buildId),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // react-markdown + remark-gfm/remark-breaks (and their
          // micromark/mdast/unified transitive tree) are used eagerly by
          // several always-mounted screens (Home/brief, notes, FAQ,
          // confirmation settings) so they can't be React.lazy-deferred
          // without a loading flash on the most common landing tab. Splitting
          // them into their own vendor chunk (WSH perf pass, plan §16)
          // doesn't reduce total bytes shipped on first load, but keeps them
          // out of the main app chunk so the two cache independently --
          // markdown-renderer code changes far less often than app code.
          markdown: ['react-markdown', 'remark-gfm', 'remark-breaks'],
        },
      },
    },
  },
})
