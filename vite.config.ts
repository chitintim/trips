import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/trips/',
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
