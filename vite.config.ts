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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), rewriteBaseInStaticFiles()],
  base,
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
