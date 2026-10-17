import { defineConfig } from 'astro/config'

// Fully static output: `dist/` is served as-is by nginx (see Dockerfile).
export default defineConfig({
  output: 'static',
  build: { inlineStylesheets: 'auto' },
})
