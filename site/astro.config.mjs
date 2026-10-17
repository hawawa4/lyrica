import { defineConfig } from 'astro/config'

// Fully static output: `dist/` is served as-is by nginx (see Dockerfile).
export default defineConfig({
  site: 'https://lyrica.hawawa.org',
  output: 'static',
  build: { inlineStylesheets: 'auto' },
})
